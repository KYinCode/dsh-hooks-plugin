// dsh-hooks: Claude Code style hooks for DeepSeek Harness.
//
// Host-half plugin row (installed as a profile bundle — see package.json
// dsh.bundle.patch and cordis.patch.yml):
//   - id: dsh-hooks-plugin
//     name: 'dsh-hooks-plugin'
//
// Config files (CC-compatible JSON, four layers):
//   ~/.dsh/hooks.json                  global (all projects)
//   <preset-dir>/hooks.json            preset template (beside agent.cordis.yml)
//   <project>/.dsh/hooks.json          project (shared, committed)
//   <project>/.dsh/hooks.local.json    project-local (personal, gitignored)
//
// Layer order: global → preset → project → project-local. Hooks of the same
// event all run in that layer order × matcher order × array order, serial.
// Dedup follows CC 2.1.88 hookDedupKey: the same hook key across layers runs
// only once and the last-merged layer wins (command = shell+command+if;
// http = url+if; prompt/agent = prompt+if; callback/function not deduped).
//
// Protocol: the hook input JSON is written to the command's stdin (one line),
// matching CC's createBaseHookInput plus DSH delegation fields. The hook's
// stdout JSON is parsed (continue/suppressOutput/decision/reason/systemMessage
// + hookSpecificOutput.permissionDecision|permissionDecisionReason|updatedInput|
// additionalContext). A first stdout line {"async":true} backgroundizes v2;
// v1 detects it and skips the decision only.
//
// Event wiring (per agent controller):
//   tools/pre-execute   -> PreToolUse    (deny materializes an official failed tool card)
//   tools/post-execute  -> PostToolUse   (accept / block via feedback)
//   agent/inbox/inserted-> UserPromptSubmit (default top-level only)
//   agent/session-start -> SessionStart
//   agent/turn-stopping -> Stop
//   subagent/end        -> SubagentEnd   (fires at the delegator, routed by parent)
//   agent/disposed      -> SessionEnd + cleanup
//
// Trust model: hooks.json is executable project content, same trust as
// package.json scripts. Commands run through the shell service, so DSH's own
// sandbox/approval stack applies (credential scrub + configured confinement).
//
// Logs: ctx.logger plus ~/.dsh/logs/dsh-hooks/dsh-hooks.log.

import { watchFile, unwatchFile } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { appendFile, mkdir } from 'node:fs/promises'

export const name = 'dsh-hooks'
export const inject = ['webServer']

const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
const LOG_FILE = join(DSH_HOME, 'logs', 'dsh-hooks', 'dsh-hooks.log')
const DEFAULT_HOOK_SHELL = 'bash'
const DEFAULT_HOOK_TIMEOUT_MS = 60_000
const WATCH_INTERVAL_MS = 500
const WATCH_DEBOUNCE_MS = 300
const ASYNC_MARKER = '{"async":true}'

// CC hook event names we can dispatch (subset wired in v1).
const CC_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'SubagentStart',
  'SubagentEnd',
])

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

let logFileReady = null
function fileLog(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`
  if (logFileReady === null) {
    logFileReady = mkdir(dirname(LOG_FILE), { recursive: true })
      .then(() => appendFile(LOG_FILE, line))
      .catch(() => {})
  } else {
    logFileReady = logFileReady.then(() => appendFile(LOG_FILE, line)).catch(() => {})
  }
}

function log(ctx, level, message) {
  try {
    if (ctx && ctx.logger && typeof ctx.logger[level] === 'function') ctx.logger[level](`dsh-hooks: ${message}`)
  } catch { /* logger absence is not fatal */ }
  fileLog(level, message)
}

// ---------------------------------------------------------------------------
// pure helpers (exported for testing) — CC 2.1.88 semantics, source-verified
// ---------------------------------------------------------------------------

/**
 * CC `matchesPattern` (utils/hooks.ts:1346): empty/`*` matches all; a pure
 * `[a-zA-Z0-9_|]+` string is exact (pipe = multi-value, case-insensitive for
 * DSH tool names); anything else is a regex (invalid regex returns false).
 * Legacy-tool normalization is skipped — DSH tool names are canonical.
 */
export function matchesPattern(matchQuery, matcher) {
  if (!matcher || matcher === '*') return true
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    const query = String(matchQuery).toLowerCase()
    if (matcher.includes('|')) {
      const patterns = matcher.split('|').map((p) => p.trim().toLowerCase())
      return patterns.includes(query)
    }
    return query === matcher.toLowerCase()
  }
  try {
    return new RegExp(matcher).test(String(matchQuery))
  } catch {
    return false
  }
}

/**
 * CC `permissionRuleValueFromString` (permissionRuleParser.ts:93):
 * "Bash" -> {toolName}, "Bash(npm install)" -> {toolName, ruleContent}.
 * Handles escaped parentheses in the content portion.
 */
export function parsePermissionRule(ruleString) {
  const s = String(ruleString)
  const open = firstUnescapedChar(s, '(')
  if (open === -1) return { toolName: s, ruleContent: undefined }
  const close = lastUnescapedChar(s, ')')
  if (close === -1 || close <= open || close !== s.length - 1) return { toolName: s }
  const toolName = s.slice(0, open)
  const rawContent = s.slice(open + 1, close)
  if (!toolName || rawContent === '' || rawContent === '*') return { toolName }
  return { toolName, ruleContent: unescapeRuleContent(rawContent) }
}

function firstUnescapedChar(str, char) {
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) {
      let bs = 0
      for (let j = i - 1; j >= 0 && str[j] === '\\'; j--) bs++
      if (bs % 2 === 0) return i
    }
  }
  return -1
}

function lastUnescapedChar(str, char) {
  for (let i = str.length - 1; i >= 0; i--) {
    if (str[i] === char) {
      let bs = 0
      for (let j = i - 1; j >= 0 && str[j] === '\\'; j--) bs++
      if (bs % 2 === 0) return i
    }
  }
  return -1
}

function unescapeRuleContent(content) {
  return content.replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\')
}

/** Small glob (`*` any run, `?` one char) -> anchored RegExp for `if` content. */
function globToRegExp(glob) {
  let out = '^'
  for (const ch of glob) {
    if (ch === '*') out += '.*'
    else if (ch === '?') out += '.'
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(out + '$')
}

/**
 * Evaluate one hook `if` condition (permission-rule syntax) against the
 * current tool call. Only meaningful for tool events. Tool name matching is
 * case-insensitive (DSH tool names are lowercase); rule content is a glob that
 * must match at least ONE string leaf of the tool input (a `Read(*.ts)` rule
 * matches a `read` call whose path argument ends in `.ts`), falling back to
 * the stringified input. Invalid globs are logged as non-matches.
 */
export function matchIfCondition(ifCondition, toolName, toolInput) {
  const parsed = parsePermissionRule(ifCondition)
  if (parsed.toolName.toLowerCase() !== String(toolName).toLowerCase()) return false
  if (!parsed.ruleContent) return true
  const regex = globToRegExp(parsed.ruleContent)
  const leaves = []
  collectStringLeaves(toolInput, leaves)
  for (const leaf of leaves) {
    if (regex.test(leaf)) return true
  }
  if (leaves.length === 0) return regex.test(JSON.stringify(toolInput ?? {}))
  return false
}

/** Recursively collect every string value in a tool-input object. */
export function collectStringLeaves(value, out) {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) collectStringLeaves(value[key], out)
  }
}

/** CC hookDedupKey payload for one hook (utils/hooks.ts:1453). */
export function hookDedupKey(hook) {
  const ifCond = hook.if ?? ''
  switch (hook.type) {
    case 'command':
      return `${hook.shell ?? DEFAULT_HOOK_SHELL}\0${hook.command}\0${ifCond}`
    case 'http':
      return `${hook.url}\0${ifCond}`
    case 'prompt':
    case 'agent':
      return `${hook.prompt}\0${ifCond}`
    default: // callback / function — never deduped
      return null
  }
}

// ---------------------------------------------------------------------------
// config loading (four layers)
// ---------------------------------------------------------------------------

/**
 * Parse one hooks.json document into a Map<event, matcher[]> with the layer's
 * `subagents` default folded onto each matcher. Throws on invalid shape.
 */
export function parseHookConfig(text) {
  let json
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON: ${error.message}`)
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('hooks.json must contain an object of hook-event arrays')
  }
  const byEvent = new Map()
  for (const [event, matchers] of Object.entries(json)) {
    if (!CC_EVENTS.has(event)) continue
    if (!Array.isArray(matchers)) throw new Error(`event "${event}" must be an array of matcher groups`)
    const normalized = []
    for (const raw of matchers) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`event "${event}": matcher group must be an object`)
      }
      // Default: subagents DO trigger hooks (§7.2). A matcher declares
      // "subagents": false to opt out.
      const subagents = raw.subagents === undefined ? true : raw.subagents === true
      const hooks = Array.isArray(raw.hooks) ? raw.hooks : []
      const matcher = typeof raw.matcher === 'string' ? raw.matcher : ''
      for (const hook of hooks) {
        if (hook === null || typeof hook !== 'object' || Array.isArray(hook)) {
          throw new Error(`event "${event}": hook must be an object`)
        }
        if (hook.type !== 'command' && hook.type !== 'http') {
          throw new Error(`event "${event}": unsupported hook type "${String(hook.type)}" (v1 supports command/http)`)
        }
        if (hook.type === 'command' && typeof hook.command !== 'string') {
          throw new Error(`event "${event}": command hook must declare a string "command"`)
        }
        if (hook.type === 'http' && typeof hook.url !== 'string') {
          throw new Error(`event "${event}": http hook must declare a string "url"`)
        }
      }
      normalized.push({ matcher, hooks, subagents })
    }
    byEvent.set(event, normalized)
  }
  return byEvent
}

function layerFiles(presetDir, cwd, globalHooksPath) {
  return [
    { kind: 'global', path: globalHooksPath || join(DSH_HOME, 'hooks.json') },
    ...(presetDir ? [{ kind: 'preset', path: join(presetDir, 'hooks.json') }] : []),
    { kind: 'project', path: cwd ? join(cwd, '.dsh', 'hooks.json') : null },
    { kind: 'local', path: cwd ? join(cwd, '.dsh', 'hooks.local.json') : null },
  ].filter((l) => l.path !== null)
}

/**
 * Read all existing layer files and merge per event with CC dedup (same key
 * across layers runs once; last-merged layer wins; order = layer × matcher ×
 * array). Returns { byEvent: Map<event, matcher[]>, sources: string[] }.
 * A missing file simply contributes nothing.
 * @param presetDir - preset directory for its hooks.json (optional).
 * @param cwd - project root; <cwd>/.dsh/hooks.json and hooks.local.json.
 * @param warn - warning sink.
 * @param globalHooksPath - override for the global layer path (tests).
 */
export async function loadConfig(presetDir, cwd, warn, globalHooksPath) {
  const byEvent = new Map()
  const sources = []
  for (const layer of layerFiles(presetDir, cwd, globalHooksPath)) {
    let text
    try {
      text = await readFile(layer.path, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') continue
      if (warn) warn(`cannot read ${layer.path}: ${String(error)}`)
      continue
    }
    let layerEvents
    try {
      layerEvents = parseHookConfig(text)
    } catch (error) {
      if (warn) warn(`${layer.path}: ${error.message} — layer skipped`)
      continue
    }
    sources.push(layer.path)
    for (const [event, matchers] of layerEvents) {
      let merged = byEvent.get(event)
      if (merged === undefined) {
        merged = []
        byEvent.set(event, merged)
      }
      // Dedup: flatten existing + new, keep last occurrence per key, first position.
      const accumulated = [
        ...merged.flatMap((m) => m.hooks.map((h) => ({ matcher: m.matcher, subagents: m.subagents, hook: h }))),
        ...matchers.flatMap((m) => m.hooks.map((h) => ({ matcher: m.matcher, subagents: m.subagents, hook: h }))),
      ]
      const seen = new Map() // key -> index in order
      const order = []
      for (const entry of accumulated) {
        const key = hookDedupKey(entry.hook)
        if (key === null) {
          order.push(entry) // callback/function: every unique
          continue
        }
        if (seen.has(key)) {
          order[seen.get(key)] = entry // last merged layer wins, position kept
        } else {
          seen.set(key, order.length)
          order.push(entry)
        }
      }
      // Rebuild matcher groups preserving first-seen matcher/subagents per position.
      merged.length = 0
      const groups = new Map() // matcherKey -> index
      for (const entry of order) {
        const matcherKey = `${entry.matcher}\0${entry.subagents ? 1 : 0}`
        let gi = groups.get(matcherKey)
        if (gi === undefined) {
          gi = merged.length
          groups.set(matcherKey, gi)
          merged.push({ matcher: entry.matcher, subagents: entry.subagents, hooks: [] })
        }
        merged[gi].hooks.push(entry.hook)
      }
    }
  }
  return { byEvent, sources }
}

/**
 * Filter resolved hooks by the `once` runtime set (§3.2): a hook declared
 * `once: true` runs at most once per agent controller; once consumed its
 * dedup key (event × hookDedupKey) is excluded from later resolutions. Pure —
 * the consumed-set is owned by the per-agent controller and survives config
 * hot-reloads (once = once per controller lifetime, not per config refresh).
 */
export function applyOnceFilter(hooks, hookEvent, consumedKeys) {
  return hooks.filter((hook) => {
    if (!hook.once) return true
    const key = hookDedupKey(hook)
    return !consumedKeys.has(`${hookEvent}\0${key}`)
  })
}

/**
 * CC `getMatchingHooks` equivalent: pick matchers by the event's match field,
 * flatten, dedup, then apply `if` conditions (tool events only) and the
 * `subagents` gate. The `once` set is applied by the caller via
 * applyOnceFilter (it lives on the per-agent controller).
 */
export function getMatchingHooks(config, hookEvent, hookInput, isSubagent) {
  const matchers = config.get(hookEvent)
  if (!matchers || matchers.length === 0) return []

  const matchQuery = eventMatchQuery(hookEvent, hookInput)
  const matched = []
  for (const m of matchers) {
    if (isSubagent && m.subagents === false) continue
    if (matchQuery !== undefined && !matchesPattern(matchQuery, m.matcher)) continue
    matched.push(...m.hooks)
  }

  // Dedup across matchers at resolve time too (same key may appear in two
  // matchers of one document); last wins, first position kept.
  const seen = new Map()
  const order = []
  for (const hook of matched) {
    const key = hookDedupKey(hook)
    if (key === null) {
      order.push(hook)
      continue
    }
    if (seen.has(key)) {
      order[seen.get(key)] = hook
    } else {
      seen.set(key, order.length)
      order.push(hook)
    }
  }

  const toolEvent =
    hookEvent === 'PreToolUse' || hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure'
  return order.filter((hook) => {
    if (!toolEvent || !hook.if) return true
    return matchIfCondition(hook.if, hookInput.tool_name, hookInput.tool_input)
  })
}

/** CC getMatchingHooks match-field switch (utils/hooks.ts:1616). */
function eventMatchQuery(hookEvent, hookInput) {
  switch (hookEvent) {
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return hookInput.tool_name
    case 'SessionStart':
      return hookInput.source
    case 'SessionEnd':
      return hookInput.reason
    case 'SubagentStart':
    case 'SubagentEnd':
      return hookInput.agent_type
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// executor (shell command + http)
// ---------------------------------------------------------------------------

/** Build the CC-compatible hook input JSON for one event. */
function buildHookInput(ctx, agent, hookEvent, extra) {
  const cwd = agentCwd(agent)
  const depth = agentDepth(agent)
  const isSubagent = depth > 0 || (agent.session && agent.session.header && agent.session.header.origin === 'subagent')
  return {
    session_id: String(agent.id),
    cwd,
    hook_event_name: hookEvent,
    permission_mode: undefined,
    ...(isSubagent ? { agent_id: String(agent.id), agent_type: agentType(agent), delegation_depth: depth } : {}),
    ...extra,
  }
}

function agentCwd(agent) {
  return (
    (agent && agent.session && agent.session.header && agent.session.header.cwd) ||
    (agent && agent.header && agent.header.cwd) ||
    undefined
  )
}

function agentDepth(agent) {
  const h = agent && agent.session && agent.session.header
  return (h && h.delegationDepth) || 0
}

function agentType(agent) {
  const h = agent && agent.session && agent.session.header
  return h && h.origin === 'subagent' ? 'subagent' : (h && h.agentPreset) || undefined
}

/**
 * Run one command hook through the shell service. stdin carries the one-line
 * JSON input; stdout is captured (capped) and its JSON parsed as the decision.
 * Cancellation propagates through exec.signal into the shell spec.
 */
async function runCommandHook(ctx, state, hook, hookInput, signal) {
  const shell = ctx.get('shell')
  if (!shell || typeof shell.resolve !== 'function' || typeof shell.run !== 'function') {
    return { status: 1, stdout: '', stderr: 'shell service unavailable', timedOut: false, aborted: false, elapsedMs: 0, async: false }
  }
  const cwd = hookInput.cwd || process.cwd()
  // §7.2: the hook command runs in the TRIGGERER's own sandbox context —
  // resolve the agent's session sandbox policy and hand it to the shell
  // executor, mirroring the official bash tool.
  let sandboxPolicy
  const sandboxSvc = ctx.get('sandboxPolicy')
  if (sandboxSvc && typeof sandboxSvc.resolve === 'function') {
    try {
      sandboxPolicy = state.agent ? sandboxSvc.resolve({ session: state.agent.session }) : sandboxSvc.resolve({})
    } catch (error) {
      log(ctx, 'warn', `agent ${state.agent.id}: sandbox policy resolve failed: ${String(error)}`)
    }
  }
  let spec
  try {
    spec = shell.resolve({
      command: hook.command,
      workdir: cwd,
      timeoutMs: typeof hook.timeout === 'number' && hook.timeout > 0 ? hook.timeout * 1000 : DEFAULT_HOOK_TIMEOUT_MS,
      stdin: JSON.stringify(hookInput) + '\n',
      // No CC-specific env passthrough (CLAUDE_PROJECT_DIR / CLAUDE_PLUGIN_ROOT):
      // the hook input already carries cwd, and DSH has no plugin/skill dirs to
      // point at. The shell executor merges its own managed DSH_* snapshot.
      ...(sandboxPolicy !== undefined ? { sandboxPolicy } : {}),
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    return { status: 1, stdout: '', stderr: String(error), timedOut: false, aborted: false, async: false }
  }
  const started = Date.now()
  const result = await shell.run(spec)
  const elapsedMs = Date.now() - started
  const stdoutText = typeof result.stdout === 'string' ? result.stdout : result.stdout && result.stdout.text || ''
  const stderrText = typeof result.stderr === 'string' ? result.stderr : result.stderr && result.stderr.text || ''
  return {
    status: result.exitCode ?? (result.aborted ? 1 : 0),
    stdout: stdoutText,
    stderr: stderrText,
    timedOut: result.timedOut === true,
    aborted: result.aborted === true,
    elapsedMs,
    async: firstLineIsAsync(stdoutText),
  }
}

/** Run one http hook: POST the input JSON to the url, parse the JSON body. */
async function runHttpHook(state, hook, hookInput, signal) {
  const started = Date.now()
  try {
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal && signal.reason)
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    let timer
    if (typeof hook.timeout === 'number' && hook.timeout > 0) {
      timer = setTimeout(() => controller.abort(new Error(`http hook timed out after ${hook.timeout}s`)), hook.timeout * 1000)
    }
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(hook.headers || {}) },
      body: JSON.stringify(hookInput),
      signal: controller.signal,
    })
    const body = await res.text()
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
    return {
      status: res.status,
      stdout: body,
      stderr: '',
      timedOut: false,
      aborted: controller.signal.aborted && !!signal && signal.aborted,
      elapsedMs: Date.now() - started,
      async: firstLineIsAsync(body),
    }
  } catch (error) {
    return {
      status: 1,
      stdout: '',
      stderr: String(error),
      timedOut: false,
      aborted: !!(signal && signal.aborted),
      elapsedMs: Date.now() - started,
      async: false,
    }
  }
}

function firstLineIsAsync(text) {
  const line = (text || '').split('\n').find((l) => l.trim().length > 0)
  return line !== undefined && line.trim() === ASYNC_MARKER
}

/**
 * Parse a hook's stdout JSON into the CC decision surface. Returns
 * { json, plainText } — plain text when stdout is not JSON, plus the raw text
 * so callers can pass SessionStart/UserPromptSubmit text to the model.
 */
export function parseHookOutput(stdout) {
  const trimmed = (stdout || '').trim()
  if (!trimmed.startsWith('{')) return { plainText: stdout || '', json: undefined }
  try {
    return { json: JSON.parse(trimmed), plainText: undefined }
  } catch {
    return { plainText: stdout || '', json: undefined }
  }
}

/** Execute one event's matched hooks serially; returns per-hook decisions. */
async function executeHooks(ctx, state, agent, hookEvent, hookInput, signal) {
  // Preset-layer self-healing: while the agent hasn't joined its preset yet
  // (see ensurePresetDir), re-read config on each run so the FIRST execution
  // after the join picks up <preset-dir>/hooks.json. Bounded: once the preset
  // resolves (or a permanent probe verdict lands) the retry stops.
  if (state.presetDir === undefined && !state.presetProbed && !state.disposed) {
    await refreshConfig(state)
  }
  const results = []
  for (const hook of state.hooksFor(hookEvent, hookInput)) {
    if (signal && signal.aborted) break
    const outcome =
      hook.type === 'http'
        ? await runHttpHook(state, hook, hookInput, signal)
        : await runCommandHook(ctx, state, hook, hookInput, signal)
    const parsed = parseHookOutput(outcome.stdout)
    results.push({
      hook,
      outcome,
      json: parsed.json,
      plainText: parsed.plainText,
      // v1: an async-marked hook contributes no synchronous decision.
      async: outcome.async === true,
    })
    recordHook(state, agent, {
      event: hookEvent,
      name: hookNameOf(hook),
      type: hook.type,
      status: outcome.status,
      timedOut: outcome.timedOut === true,
      aborted: outcome.aborted === true,
      elapsedMs: outcome.elapsedMs,
      decision: decisionLabel(parsed.json, hook.type),
      async: outcome.async === true,
      stdout: outcome.stdout || '',
      stderr: outcome.stderr || '',
      reason: reasonOf(parsed.json),
    })
    // §3.2 `once`: a once-hook is consumed after its FIRST execution on this
    // controller regardless of outcome; later event fires skip it.
    if (hook.once === true) {
      const onceKey = hookDedupKey(hook)
      if (onceKey !== null) state.onceConsumed.add(`${hookEvent}\0${onceKey}`)
    }
  }
  return results
}

function hookNameOf(hook) {
  return hook.type === 'command' ? hook.command : hook.type === 'http' ? hook.url : hook.type
}

function decisionLabel(json, type) {
  if (!json) return undefined
  const specific = json.hookSpecificOutput
  if (specific && specific.permissionDecision) return specific.permissionDecision
  if (json.decision) return json.decision
  if (json.continue === false) return 'block-hop'
  return undefined
}

function reasonOf(json) {
  if (!json) return undefined
  const specific = json.hookSpecificOutput
  return specific && specific.permissionDecisionReason
    ? specific.permissionDecisionReason
    : typeof json.reason === 'string'
      ? json.reason
      : undefined
}

// A PreToolUse decision aggregate: { kind: 'allow'|'deny'|'ask', reason } with
// context/additional input the caller consumes (v1 skips updatedInput since
// DSH pre-execute excludes input rewriting — arguments are already logged).
function preToolDecision(results) {
  for (const r of results) {
    if (r.async) continue // async hooks contribute nothing synchronously
    const specific = r.json && r.json.hookSpecificOutput
    const behavior = specific && specific.permissionDecision
    if (behavior === 'deny') {
      return { kind: 'deny', reason: specific.permissionDecisionReason || `denied by hook ${r.name}` }
    }
    if (behavior === 'ask') {
      return { kind: 'ask', reason: specific.permissionDecisionReason }
    }
    if (r.json && r.json.decision === 'block') {
      return { kind: 'deny', reason: r.json.reason || `blocked by hook ${r.name}` }
    }
    if (r.json && r.json.continue === false) {
      return { kind: 'deny', reason: r.json.reason || `continuation blocked by hook ${r.name}` }
    }
  }
  return undefined // allow
}

function collectAdditionalContext(results) {
  const out = []
  for (const r of results) {
    if (r.async) continue
    const specific = r.json && r.json.hookSpecificOutput
    if (specific && typeof specific.additionalContext === 'string' && specific.additionalContext.length > 0) {
      out.push(specific.additionalContext)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// per-agent controller
// ---------------------------------------------------------------------------

const agentStates = new Map() // agent.id -> controller
const projectWatchers = new Map() // projectRoot -> { controllers: Set, timer }
const subagentParents = new Map() // childSessionId -> parentSessionId (recorded at subagent/start)

function createController(ctx, agent, cwd) {
  return {
    ctx,
    agent,
    cwd,
    presetDir: undefined,
    config: new Map(),
    sources: [],
    disposed: false,
    watcherRef: null,
    queue: Promise.resolve(),
    recordBuf: [],
    presetProbed: false, // preset-directory lookup attempted with a final verdict
    onceConsumed: new Set(), // `${event}\0${hookDedupKey}` — once hooks, per controller
    hooksFor(event, hookInput) {
      const resolved = getMatchingHooks(this.config, event, hookInput, hookDepth(this.agent) > 0)
      return applyOnceFilter(resolved, event, this.onceConsumed)
    },
  }
}

function hookDepth(agent) {
  const h = agent && agent.session && agent.session.header
  return (h && h.delegationDepth) || 0
}

function enqueue(state, fn) {
  state.queue = state.queue.then(fn).catch((error) => {
    if (!state.disposed) log(state.ctx, 'error', `agent ${state.agent.id}: ${String(error)}`)
  })
  return state.queue
}

/**
 * Resolve the agent's preset directory for the preset config layer (a
 * `<preset-dir>/hooks.json` beside its agent.cordis.yml). Resolution is lazy
 * because `agent/created` fires BEFORE the agent factory links the agent to
 * its preset standing scope — `composedPreset()` is frequently still
 * undefined at that point. Callers re-enter this until one resolution sticks:
 * a not-yet-joined agent returns undefined WITHOUT a permanent probe flag, so
 * a later event (session-start / first hook execution) retries; an absent
 * roster service or a failed resolve sets the flag and stops retrying.
 */
async function ensurePresetDir(state) {
  if (state.disposed || state.presetDir !== undefined || state.presetProbed) return
  const presets = state.ctx.get('agentPresets')
  if (!presets || typeof presets.composedPreset !== 'function' || typeof presets.resolve !== 'function') {
    state.presetProbed = true // no roster service — permanent
    return
  }
  try {
    const presetId = presets.composedPreset(state.agent.ctx)
    if (!presetId) return // not yet joined — retry later, do not mark probed
    const preset = await presets.resolve(presetId)
    state.presetDir = dirname(preset.path)
    log(state.ctx, 'info', `agent ${state.agent.id}: preset layer resolved -> ${state.presetDir}/hooks.json (preset ${presetId})`)
  } catch (error) {
    state.presetProbed = true
    log(state.ctx, 'warn', `agent ${state.agent.id}: preset layer resolution failed: ${String(error)}`)
  }
}

async function refreshConfig(state) {
  if (state.disposed) return
  await ensurePresetDir(state)
  const loaded = await loadConfig(state.presetDir, state.cwd, (m) =>
    log(state.ctx, 'warn', `agent ${state.agent.id}: ${m}`),
  )
  if (state.disposed) return
  state.config = loaded.byEvent
  state.sources = loaded.sources
  log(state.ctx, 'info', `agent ${state.agent.id} (${state.cwd}): config from ${state.sources.length ? state.sources.join(', ') : 'no hooks.json found'}`)
}

function attachWatcher(state) {
  const root = state.cwd
  if (!root) return
  let w = projectWatchers.get(root)
  if (w === undefined) {
    w = { controllers: new Set(), timer: null }
    projectWatchers.set(root, w)
    const targets = [join(root, '.dsh', 'hooks.json'), join(root, '.dsh', 'hooks.local.json')]
    const onChange = () => {
      if (w.timer !== null) clearTimeout(w.timer)
      w.timer = setTimeout(() => {
        w.timer = null
        for (const controller of [...w.controllers]) {
          if (!controller.disposed) enqueue(controller, () => refreshConfig(controller))
        }
      }, WATCH_DEBOUNCE_MS)
    }
    for (const target of targets) {
      try {
        watchFile(target, { interval: WATCH_INTERVAL_MS }, onChange)
      } catch (error) {
        log(state.ctx, 'warn', `watch ${target} failed: ${String(error)}`)
      }
    }
  }
  w.controllers.add(state)
  state.watcherRef = w
}

function detachWatcher(state) {
  const w = state.watcherRef
  if (w === undefined) return
  state.watcherRef = undefined
  w.controllers.delete(state)
  if (w.controllers.size === 0) {
    if (w.timer !== null) clearTimeout(w.timer)
    for (const target of [join(state.cwd, '.dsh', 'hooks.json'), join(state.cwd, '.dsh', 'hooks.local.json')]) {
      try { unwatchFile(target) } catch { /* best effort */ }
    }
    projectWatchers.delete(state.cwd)
  }
}

function cleanupState(ctx, state, reason) {
  if (state.disposed) return
  state.disposed = true
  agentStates.delete(state.agent.id)
  detachWatcher(state)
  log(ctx, 'info', `agent ${state.agent.id}: cleanup (${reason})`)
}

// ---------------------------------------------------------------------------
// record store: Hook host-side memory (cap 100) + file history
// ---------------------------------------------------------------------------

const recentRecords = [] // newest last, cap 100
function recordHook(state, agent, rec) {
  const depth = hookDepth(agent)
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    session_id: String(agent.id),
    cwd: state.cwd,
    delegation_depth: depth,
    ...(depth > 0 ? { agent_id: String(agent.id), agent_type: agentType(agent) } : {}),
    ...rec,
  }
  recentRecords.push(entry)
  if (recentRecords.length > 100) recentRecords.splice(0, recentRecords.length - 100)
  try {
    fileLog('info', `hook ${entry.event} ${entry.name} -> ${entry.status} (${entry.elapsedMs ?? 0}ms) decision=${entry.decision ?? '-'}${entry.reason ? ` reason="${entry.reason}"` : ''}`)
  } catch { /* best effort */ }
}

function recentRecordsSnapshot() {
  return recentRecords.slice()
}

// ---------------------------------------------------------------------------
// event wiring
// ---------------------------------------------------------------------------

function wireAgent(ctx, agent) {
  const cwd = agentCwd(agent)
  if (!cwd) {
    log(ctx, 'warn', `agent ${agent.id}: no session cwd found — hooks skipped`)
    return
  }
  const agentCtx = agent.ctx
  if (!agentCtx || typeof agentCtx.on !== 'function') {
    log(ctx, 'warn', `agent ${agent.id}: agent context unavailable — hooks skipped`)
    return
  }
  const state = createController(ctx, agent, cwd)
  agentStates.set(agent.id, state)
  attachWatcher(state)
  // Initial config load. Preset-layer resolution is lazy (see ensurePresetDir):
  // `agent/created` fires before the agent joins its preset scope, so the first
  // load may lack the preset layer; executeHooks re-refreshes until it sticks.
  enqueue(state, () => refreshConfig(state))

  // PreToolUse: deny materializes an official failed tool card (isError:true).
  agentCtx.on('tools/pre-execute', async (exec, next) => {
    if (state.disposed) return next()
    try {
      const hookInput = buildHookInput(ctx, agent, 'PreToolUse', {
        tool_name: exec.name,
        tool_input: exec.arguments ?? {},
        tool_use_id: String(exec.callId ?? ''),
      })
      const results = await executeHooks(ctx, state, agent, 'PreToolUse', hookInput, exec.signal)
      const decision = preToolDecision(results)
      if (decision && decision.kind === 'deny') return { kind: 'deny', reason: decision.reason || 'denied by hook' }
      if (decision && decision.kind === 'ask') return { kind: 'ask', reason: decision.reason }
      const context = collectAdditionalContext(results)
      if (context.length > 0) {
        try { agent.inject(createTextUserMessage(context.join('\n\n'), 'dsh-hooks')) } catch { /* best effort */ }
      }
      return next()
    } catch (error) {
      log(ctx, 'error', `agent ${agent.id} PreToolUse hooks failed: ${String(error)}`)
      return next()
    }
  })

  // PostToolUse (includes PostToolUseFailure via the error branch of result).
  agentCtx.on('tools/post-execute', async (exec, result, next) => {
    if (state.disposed) return next()
    try {
      const failure = result && result.isError === true
      const hookEvent = failure ? 'PostToolUseFailure' : 'PostToolUse'
      const hookInput = buildHookInput(ctx, agent, hookEvent, {
        tool_name: exec.name,
        tool_input: exec.arguments ?? {},
        tool_use_id: String(exec.callId ?? ''),
        tool_response: outputTextOf(result),
      })
      const results = await executeHooks(ctx, state, agent, hookEvent, hookInput, exec.signal)
      const context = collectAdditionalContext(results)
      if (context.length > 0) {
        try { agent.inject(createTextUserMessage(context.join('\n\n'), 'dsh-hooks')) } catch { /* best effort */ }
      }
      return next()
    } catch (error) {
      log(ctx, 'error', `agent ${agent.id} PostToolUse hooks failed: ${String(error)}`)
      return next()
    }
  })

  // UserPromptSubmit: default top-level only (programmatic subagent inbox
  // deliveries are not "user submits" and would misfire progress notices).
  agentCtx.on('agent/inbox/inserted', (payload) => {
    if (state.disposed) return
    const depth = hookDepth(agent)
    if (depth > 0) return
    const message = payload && payload.message
    if (!message) return
    try {
      const hookInput = buildHookInput(ctx, agent, 'UserPromptSubmit', {
        prompt: textOfMessage(message),
      })
      enqueue(state, async () => {
        const results = await executeHooks(ctx, state, agent, 'UserPromptSubmit', hookInput)
        const context = collectAdditionalContext(results)
        if (context.length > 0) {
          try { agent.inject(createTextUserMessage(context.join('\n\n'), 'dsh-hooks')) } catch { /* best effort */ }
        }
      }).catch(() => {})
    } catch (error) {
      log(ctx, 'error', `agent ${agent.id} UserPromptSubmit hooks failed: ${String(error)}`)
    }
  })

  // SessionStart.
  agentCtx.on('agent/session-start', (payload) => {
    if (state.disposed) return
    const source = (payload && payload.source) || 'startup'
    const hookInput = buildHookInput(ctx, agent, 'SessionStart', { source })
    enqueue(state, async () => {
      const results = await executeHooks(ctx, state, agent, 'SessionStart', hookInput)
      const context = collectAdditionalContext(results)
      if (context.length > 0) {
        try { agent.inject(createTextUserMessage(context.join('\n\n'), 'dsh-hooks')) } catch { /* best effort */ }
      }
    }).catch(() => {})
  })

  // Stop.
  agentCtx.on('agent/turn-stopping', (payload) => {
    if (state.disposed) return
    const hookInput = buildHookInput(ctx, agent, 'Stop', {})
    enqueue(state, () => executeHooks(ctx, state, agent, 'Stop', hookInput, payload && payload.signal)).catch(() => {})
  })
}

function outputTextOf(result) {
  if (!result) return undefined
  const content = result.content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  }
  return undefined
}

function textOfMessage(message) {
  const content = message && message.content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  }
  return ''
}

// Builds the minimal UserMessage shape that agent.inject consumes. Keep it
// internal to dsh-hooks: no static import of dsh-llm at module scope so a
// misconfigured peer degrades to a logged skip instead of failing plugin load.
function createTextUserMessage(text, plugin) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin },
  }
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

export function apply(ctx) {
  ctx.on('agent/created', (payload) => {
    const agent = payload && payload.agent
    if (!agent) return
    try {
      wireAgent(ctx, agent)
    } catch (error) {
      log(ctx, 'error', `agent ${agent.id}: unexpected wire failure: ${String(error)}`)
    }
  })

  ctx.on('agent/disposed', (payload) => {
    const agent = payload && payload.agent
    if (!agent) return
    const state = agentStates.get(agent.id)
    if (state !== undefined) {
      // SessionEnd hook runs on the way out, before controller cleanup.
      const hookInput = buildHookInput(ctx, agent, 'SessionEnd', { reason: 'agent-disposed' })
      enqueue(state, () => executeHooks(ctx, state, agent, 'SessionEnd', hookInput))
        .catch(() => {})
        .finally(() => cleanupState(ctx, state, 'agent disposed'))
    }
  })

  // Subagent lifecycle events are Scoped<SubagentRuntime> and deliver only the
  // single `info` argument to cordis listeners (the second `parent` argument is
  // not exposed). At subagent/start the child is still registered, so we read
  // its durable lineage (session.header.parentSession) and cache the pairing;
  // at subagent/end the child may already be disposed, so we route through the
  // cached map to find the delegator's controller.
  ctx.on('subagent/start', (info) => {
    const childId = info && info.id
    if (!childId) return
    try {
      const agents = ctx.get('agents')
      const child = agents ? agents.get(childId) : undefined
      const header = child && child.session && child.session.header
      const pid = (header && header.parentSession) || undefined
      if (pid) subagentParents.set(childId, pid)
    } catch (error) {
      log(ctx, 'warn', `subagent/start: cannot record lineage for child ${childId}: ${String(error)}`)
    }
  })

  ctx.on('subagent/end', (info) => {
    const childId = info && info.id
    const pid = childId ? subagentParents.get(childId) : undefined
    if (childId) subagentParents.delete(childId)
    if (!pid) {
      log(ctx, 'warn', `subagent/end: no cached parent for child ${childId} — SubagentEnd skipped`)
      return
    }
    const state = agentStates.get(pid)
    if (state === undefined || state.disposed) {
      log(ctx, 'warn', `subagent/end: no live controller for parent ${pid} (state=${!!state})`)
      return
    }
    const hookInput = buildHookInput(ctx, state.agent, 'SubagentEnd', {
      agent_id: String(childId),
      agent_type: (info && info.provider) || 'subagent',
    })
    enqueue(state, () => executeHooks(ctx, state, state.agent, 'SubagentEnd', hookInput)).catch(() => {})
  })

  // Client console data channel (v1: HTTP route on the web carrier; the
  // dynamic-plugin harness.handle private RPC is not available to static
  // bundles). The floating console polls /dsh-hooks/recent. `webServer` is a
  // declared hard dependency (inject), so cordis waits for the service before
  // apply runs and this route always registers — no service-absence gap.
  {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-hooks',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://dsh')
        if (url.pathname === '/dsh-hooks/recent' || url.pathname === '/dsh-hooks/recent.json') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
          res.end(JSON.stringify({ entries: recentRecordsSnapshot() }))
          return
        }
        if (url.pathname === '/dsh-hooks/health') {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('ok')
          return
        }
        res.writeHead(404)
        res.end()
      },
    })
    ctx.effect(() => dispose)
  }

  // Plugin unload: tear down every live controller (no uninstall logic beyond
  // runtime cleanup — §6 boundary; config files live and die with their dirs).
  ctx.effect(() => () => {
    for (const state of [...agentStates.values()]) {
      cleanupState(ctx, state, 'plugin reloaded')
    }
  })

  log(ctx, 'info', 'plugin active (v1) — per-agent hooks, CC protocol')
}

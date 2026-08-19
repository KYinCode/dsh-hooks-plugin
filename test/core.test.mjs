// Unit tests for the pure dsh-hooks helpers (CC 2.1.88 semantics).
// Run: node --test test/*.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  matchesPattern,
  parsePermissionRule,
  matchIfCondition,
  hookDedupKey,
  parseHookConfig,
  getMatchingHooks,
  collectStringLeaves,
  parseHookOutput,
  applyOnceFilter,
} from '../index.mjs'

test('matchesPattern: empty and * match all (CC 1346)', () => {
  assert.equal(matchesPattern('Write', ''), true)
  assert.equal(matchesPattern('Write', '*'), true)
  assert.equal(matchesPattern('anything', undefined), true)
})

test('matchesPattern: exact and pipe (case-insensitive for DSH tool names)', () => {
  assert.equal(matchesPattern('write', 'Write'), true)
  assert.equal(matchesPattern('Write', 'Write'), true)
  assert.equal(matchesPattern('write', 'Write|Edit'), true)
  assert.equal(matchesPattern('edit', 'Write|Edit'), true)
  assert.equal(matchesPattern('read', 'Write|Edit'), false)
  assert.equal(matchesPattern('web_search', 'web_fetch|web_search'), true)
})

test('matchesPattern: regex form (tool names are lowercase in DSH)', () => {
  assert.equal(matchesPattern('write_file', '^write.*'), true)
  assert.equal(matchesPattern('write', '^(write|edit)$'), true)
  assert.equal(matchesPattern('edit', '^(write|edit)$'), true)
  assert.equal(matchesPattern('read', '^(write|edit)$'), false)
})

test('matchesPattern: invalid regex returns false', () => {
  assert.equal(matchesPattern('write', '('), false)
})

test('parsePermissionRule: tool-only', () => {
  assert.deepEqual(parsePermissionRule('Bash'), { toolName: 'Bash', ruleContent: undefined })
})

test('parsePermissionRule: tool(content)', () => {
  assert.deepEqual(parsePermissionRule('Read(*.ts)'), { toolName: 'Read', ruleContent: '*.ts' })
  assert.deepEqual(parsePermissionRule('Bash(git *)'), { toolName: 'Bash', ruleContent: 'git *' })
})

test('parsePermissionRule: empty or * content collapses to tool-wide', () => {
  assert.deepEqual(parsePermissionRule('Bash()'), { toolName: 'Bash' })
  assert.deepEqual(parsePermissionRule('Bash(*)'), { toolName: 'Bash' })
})

test('parsePermissionRule: escaped parens in content (CC parser.ts:93)', () => {
  assert.deepEqual(parsePermissionRule('Bash(python -c "print\\(1\\)")'), {
    toolName: 'Bash',
    ruleContent: 'python -c "print(1)"',
  })
})

test('collectStringLeaves: gathers nested strings', () => {
  const out = []
  collectStringLeaves({ path: 'a.txt', nested: { n: 2 }, arr: ['x', 5], other: undefined }, out)
  assert.deepEqual(out.sort(), ['a.txt', 'x'])
})

test('matchIfCondition: tool name must match (case-insensitive)', () => {
  assert.equal(matchIfCondition('Write(*.ts)', 'write', { path: '/x.ts' }), true)
  assert.equal(matchIfCondition('Write(*.ts)', 'read', { path: '/x.ts' }), false)
  // tool-wide rule matches regardless of input
  assert.equal(matchIfCondition('Write', 'write', {}), true)
  assert.equal(matchIfCondition('Write', 'read', {}), false)
  // content rule with no string leaves cannot match
  assert.equal(matchIfCondition('Write(*.ts)', 'write', {}), false)
})

test('matchIfCondition: content glob over string leaves', () => {
  assert.equal(matchIfCondition('Read(*.ts)', 'read', { path: '/src/app.ts' }), true)
  assert.equal(matchIfCondition('Read(*.ts)', 'read', { path: '/src/app.js' }), false)
  assert.equal(matchIfCondition('Read(*.md)', 'read', { file_path: '/README.md' }), true)
  assert.equal(matchIfCondition('Bash(git *)', 'bash', { command: 'git status' }), true)
  assert.equal(matchIfCondition('Bash(git *)', 'bash', { command: 'npm install' }), false)
  assert.equal(matchIfCondition('Write(*.ts)', 'write', { path: 'C:\\src\\x.ts' }), true)
})

test('hookDedupKey: command = shell+command+if (CC 1744-1751, DEFAULT_HOOK_SHELL bash)', () => {
  assert.equal(hookDedupKey({ type: 'command', command: 'echo x' }), 'bash\0echo x\0')
  assert.equal(hookDedupKey({ type: 'command', command: 'echo x', shell: 'bash' }), 'bash\0echo x\0')
  assert.equal(hookDedupKey({ type: 'command', command: 'echo x', shell: 'powershell' }), 'powershell\0echo x\0')
  // different if = different identity
  assert.notEqual(
    hookDedupKey({ type: 'command', command: 'echo x', if: 'Write(*.ts)' }),
    hookDedupKey({ type: 'command', command: 'echo x' }),
  )
})

test('hookDedupKey: http = url+if; callback not deduped', () => {
  assert.equal(hookDedupKey({ type: 'http', url: 'https://x' }), 'https://x\0')
  assert.notEqual(
    hookDedupKey({ type: 'http', url: 'https://x', if: 'Write' }),
    hookDedupKey({ type: 'http', url: 'https://x' }),
  )
  assert.equal(hookDedupKey({ type: 'callback', fn: 1 }), null)
})

test('parseHookConfig: shape + validation', () => {
  const cfg = parseHookConfig(
    JSON.stringify({ PreToolUse: [{ matcher: 'Read|Write', hooks: [{ type: 'command', command: 'echo x' }] }] }),
  )
  assert.ok(cfg.has('PreToolUse'))
  assert.equal(cfg.get('PreToolUse')[0].hooks[0].command, 'echo x')
  assert.throws(() => parseHookConfig('{bad'), /invalid JSON/)
  assert.throws(() => parseHookConfig(JSON.stringify({ PreToolUse: ['not-an-object'] })), /matcher group must be an object/)
  assert.throws(() => parseHookConfig(JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }] })), /unsupported hook type/)
  assert.throws(() => parseHookConfig(JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'command' }] }] })), /must declare a string "command"/)
})

test('parseHookConfig preserves once/async/asyncRewake passthrough fields', () => {
  const cfg = parseHookConfig(
    JSON.stringify({ PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo x', once: true, async: true, asyncRewake: true }] }] }),
  )
  const h = cfg.get('PreToolUse')[0].hooks[0]
  assert.equal(h.once, true)
  assert.equal(h.async, true)
  assert.equal(h.asyncRewake, true)
})

test('applyOnceFilter: once hooks consumed per event key; non-once always run', () => {
  const once = { type: 'command', command: 'echo x', once: true }
  const plain = { type: 'command', command: 'echo y' }
  const consumed = new Set()
  const event = 'PreToolUse'
  // nothing consumed → both run
  assert.deepEqual(applyOnceFilter([once, plain], event, consumed).map((h) => h.command), ['echo x', 'echo y'])
  // consume the once key → it is excluded, plain stays
  consumed.add(`${event}\0${hookDedupKey(once)}`)
  assert.deepEqual(applyOnceFilter([once, plain], event, consumed).map((h) => h.command), ['echo y'])
  // same dedup key under a DIFFERENT event is still its own dimension
  const consumedOther = new Set([`PostToolUse\0${hookDedupKey(once)}`])
  assert.equal(applyOnceFilter([once], event, consumedOther).length, 1)
  // once command with a different `if` is a different key and not consumed
  const onceOtherIf = { type: 'command', command: 'echo x', if: 'Read(*.md)', once: true }
  assert.equal(applyOnceFilter([onceOtherIf], event, consumed).length, 1)
})

test('getMatchingHooks: matcher + if + subagents gate', () => {
  const cfg = parseHookConfig(
    JSON.stringify({
      PreToolUse: [
        { matcher: 'Read|Write', hooks: [{ type: 'command', command: 'echo a' }] },
        { matcher: 'Read', subagents: false, hooks: [{ type: 'command', command: 'echo b', if: 'Read(*.md)' }] },
      ],
    }),
  )
  // top-level read of a .md file matches both
  let hooks = getMatchingHooks(cfg, 'PreToolUse', { tool_name: 'read', tool_input: { path: 'x.md' } }, false)
  assert.deepEqual(hooks.map((h) => h.command).sort(), ['echo a', 'echo b'])
  // subagent: the subagents:false matcher is skipped
  hooks = getMatchingHooks(cfg, 'PreToolUse', { tool_name: 'read', tool_input: { path: 'x.md' } }, true)
  assert.deepEqual(hooks.map((h) => h.command), ['echo a'])
  // non-.md read: if-condition drops echo b even for top-level
  hooks = getMatchingHooks(cfg, 'PreToolUse', { tool_name: 'read', tool_input: { path: 'x.js' } }, false)
  assert.deepEqual(hooks.map((h) => h.command), ['echo a'])
})

test('parseHookOutput: JSON vs plain text', () => {
  assert.deepEqual(parseHookOutput('{"hookSpecificOutput":{"permissionDecision":"deny"}}').json.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(parseHookOutput('just text').plainText, 'just text')
})

test('loadConfig: four-layer merge + cross-layer dedup (local wins)', async () => {
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs/promises')
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-hooks-test-'))
  // global: hooks.json under DSH_HOME — emulate by writing into tmp as the global root
  const globalDir = path.join(tmp, 'global-root')
  const projectDir = path.join(tmp, 'project')
  await fs.mkdir(globalDir, { recursive: true })
  await fs.mkdir(path.join(projectDir, '.dsh'), { recursive: true })
  const hook = (c, s, ifc) => ({ type: 'command', command: c, ...(s ? { shell: s } : {}), ...(ifc !== undefined ? { if: ifc } : {}) })
  // global layer: one PreToolUse echo-g core + SessionStart
  await fs.writeFile(
    path.join(globalDir, 'hooks.json'),
    JSON.stringify({ PreToolUse: [{ matcher: 'Read|Write', hooks: [hook('echo g-core')] }], SessionStart: [{ hooks: [hook('echo g-start')] }] }),
  )
  // project layer: same command (g-core) repeated WITHOUT differentiator → deduped (same key)
  await fs.writeFile(
    path.join(projectDir, '.dsh', 'hooks.json'),
    JSON.stringify({ PreToolUse: [{ matcher: 'Read|Write', hooks: [hook('echo g-core'), hook('echo p-extra', 'bash', 'Read(*.ts)')] }] }),
  )
  // local layer: same g-core command AGAIN (still same key) → still one run; plus a distinct local hook
  await fs.writeFile(
    path.join(projectDir, '.dsh', 'hooks.local.json'),
    JSON.stringify({ PreToolUse: [{ matcher: 'Read|Write', hooks: [hook('echo g-core'), hook('echo l-only')] }] }),
  )
  const origDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = globalDir
  try {
    const { loadConfig } = await import('../index.mjs')
    const { byEvent, sources } = await loadConfig(undefined, projectDir, undefined, path.join(globalDir, 'hooks.json'))
    // three sources read (global + project + local)
    assert.equal(sources.length, 3)
    const pre = getMatchingHooks(byEvent, 'PreToolUse', { tool_name: 'read', tool_input: { path: 'a.ts' } }, false)
    const cmds = pre.map((h) => h.command).sort()
    // g-core appears exactly ONCE across the 3 layers; p-extra (different if) and l-only each run
    assert.deepEqual(cmds, ['echo g-core', 'echo l-only', 'echo p-extra'])
    // SessionStart survives
    assert.ok(getMatchingHooks(byEvent, 'SessionStart', {}, false).some((h) => h.command === 'echo g-start'))
  } finally {
    if (origDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = origDshHome
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('fileLog: rotates the log file past the byte threshold', async () => {
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs/promises')
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-hooks-log-'))
  const origHome = process.env.DSH_HOME
  const origMax = process.env.DSH_HOOKS_MAX_LOG_BYTES
  try {
    process.env.DSH_HOME = tmp
    process.env.DSH_HOOKS_MAX_LOG_BYTES = '800'
    // Fresh module instance so LOG_FILE/MAX_LOG_BYTES are captured against the
    // temp DSH_HOME and the small threshold, isolated from the real log.
    const mod = await import('../index.mjs?logrotate=' + Date.now())
    const logFile = path.join(tmp, 'logs', 'dsh-hooks', 'dsh-hooks.log')
    for (let i = 0; i < 80; i++) mod.fileLog('info', 'x'.repeat(120))
    await mod.flushLogs()
    const current = await fs.stat(logFile)
    const backup = await fs.stat(logFile + '.1').then(() => true, () => false)
    assert.equal(backup, true, 'rotated backup .1 should exist')
    assert.ok(current.size < 1500, `current log not trimmed below threshold: ${current.size}`)
  } finally {
    if (origHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = origHome
    if (origMax === undefined) delete process.env.DSH_HOOKS_MAX_LOG_BYTES
    else process.env.DSH_HOOKS_MAX_LOG_BYTES = origMax
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

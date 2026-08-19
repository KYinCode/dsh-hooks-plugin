# dsh-hooks-plugin

[中文](README.md) | [English](README.en.md)

Claude Code style hooks for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): run shell commands on agent/tool lifecycle events from `.dsh/hooks.json` (CC-compatible JSON shape).

> The product is called **dsh-hooks**; the npm / GitHub package id is **`dsh-hooks-plugin`** (the `dsh-hooks` name was taken). The runtime API and log paths keep the `dsh-hooks` name: `~/.dsh/logs/dsh-hooks/dsh-hooks.log` and `GET /dsh-hooks/recent`.

## Table of contents

- [Features (v1)](#features-v1)
- [Install](#install)
- [Example](#example)
  - [Hook field schema](#hook-field-schema)
- [CC compatibility boundary](#cc-compatibility-boundary)
- [stdin / stdout protocol (CC-compatible)](#stdin--stdout-protocol-cc-compatible)
- [Development / verification](#development--verification)
- [Out of scope (boundary)](#out-of-scope-boundary)
- [License](#license)

## Features (v1)

- **Four config layers**: global `~/.dsh/hooks.json` → preset `<preset-dir>/hooks.json` → project `<project>/.dsh/hooks.json` → project-local `.dsh/hooks.local.json`.
- **CC-compatible schema & protocol**: `matcher[] + hooks[]` layout, stdin JSON input / stdout JSON decision, so existing Claude Code hook scripts can be reused.
- **Dedup aligned with CC 2.1.88 `hookDedupKey`**: `command` = `shell+command+if`, `http` = `url+if`, `prompt/agent` = `prompt+if`; a key across layers runs once, last-merged layer wins; `callback/function` never deduped.
- **Matcher aligned with CC `matchesPattern`**: `*` matches all, `A|B` is an exact pipe list, anything else is a regex; `if` conditions support permission-rule syntax (`Bash(git *)`, `Read(*.ts)`).
- **Events**: `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `UserPromptSubmit` / `SessionStart` / `SessionEnd` / `Stop` / `SubagentEnd`.
  - A `PreToolUse` `deny` decision materializes the official tool failure card (model sees `Error: <reason>`).
- **Subagents**: trigger by default, the input payload carries `agent_id` / `agent_type` / `delegation_depth`; disable per matcher with `subagents: false`; commands run in the triggerer's own sandbox context.
- **Hot reload**: project config changes are re-read automatically (`fs.watchFile`), no restart.
- **No-restart hot upgrade**: once [`dsh-hot-installer`](https://github.com/KYinCode/dsh-hot-installer) is installed, `dsh plugin --profile web add <pkg>@<new-version>` takes effect immediately — no restart needed.
- **Session-scoped floating console**: the 🔌 Hooks console on `shell.overlay` shows only the currently viewed session's hooks (including those triggered by its subagents, marked with a `subagent·dN` badge, and the triggering tool name inline); switching sessions follows automatically and the header shows `会话·<title>`.
- **Recent records persist**: every hook record is appended to `recent.jsonl` (capped at 200, tunable via `DSH_HOOKS_RECENT_MAX`) and re-seeded on hot upgrade/restart — the console keeps its recent history.
- **Log rotation**: `~/.dsh/logs/dsh-hooks/dsh-hooks.log` rolls to `.1` beyond 1 MiB (tunable via `DSH_HOOKS_MAX_LOG_BYTES`) and keeps writing fresh — it never grows without bound.
- **Delivery**: profile bundle (`cordis.patch.yml` inserts the row), installed via `dsh plugin --profile <p> add`.
- **Manual shipped in the package**: `docs/CONFIGURATION.md` (config / protocol / boundaries) ships inside the npm tarball, so an installed agent can `read` it directly instead of reverse-engineering `index.mjs`.
- **Authoring skill auto-registered**: `apply()` registers the bundled `skills/dsh-hooks-authoring` into the skill registry (global layer); any agent sees `dsh-hooks-authoring` in its `skill` catalog right after install. Loading it yields an index of the four pinned facts + config/decision JSON + Windows/sandbox caveats; depth lives in the shipped manual.

## Install

```sh
# from npm (current latest 0.2.14)
dsh plugin --profile web add dsh-hooks-plugin

# or from a local tarball
npm pack
dsh plugin --profile web add ./dsh-hooks-plugin-0.2.14.tgz
```

New sessions pick it up automatically; **existing live sessions do too** — the plugin's `apply()` walks the `agents` registry to re-wire already-live agents, so in-process hot install/upgrade needs no new session; continuing an old session after a process restart also re-wires on agent recreation (`agent/created`).

> **For agents / hook authors**: run `skill dsh-hooks-authoring` first (auto-registered on install), and read `docs/CONFIGURATION.md` inside the installed package for depth — both ship with the package, no source-diving needed.

## Example

`<project>/.dsh/hooks.json`:

```json
{
  "PreToolUse": [
    {
      "matcher": "Read|Write|Edit",
      "hooks": [
        { "type": "command", "command": "echo hook triggered", "timeout": 5 }
      ]
    },
    {
      "matcher": "Read",
      "hooks": [
        {
          "type": "command",
          "command": "node -e \"process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'blocked'}}))\"",
          "if": "Read(*private*)",
          "timeout": 5
        }
      ]
    }
  ]
}
```

### Hook field schema

A hook is an object discriminated by `type` (aligned with CC 2.1.88 `schemas/hooks.ts`).

**Common fields (command / prompt / agent / http)**

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `type` | `"command" \| "http" \| "prompt" \| "agent"` | — | Hook kind. v1 implements `command` and `http`; `prompt`/`agent` depend on an external LLM/subagent and are out of scope (unknown types are rejected by `parseHookConfig`) |
| `if` | `string` | none | Permission-rule filter (e.g. `Bash(git *)`, `Read(*.ts)`); tool events only. Matched against `tool_name` + `tool_input` before spawn — non-matching hooks never start a process |
| `timeout` | `number` (>0) | 60 | Timeout in seconds for this command/request |
| `statusMessage` | `string` | none | **Display-only text**: custom message shown in the spinner/hook list while the hook runs; when present it replaces command/url/prompt as the hook's display name. It does **not** participate in the dedup key and does not change execution or decisions |
| `once` | `boolean` | `false` | When `true`, the hook runs once and is removed from the runtime set afterwards |

**`type: "command"` only**

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `command` | `string` (required) | — | Shell command to execute |
| `shell` | `"bash" \| "powershell"` | `bash` | Interpreter: `bash` uses `$SHELL` (bash/zsh/sh), `powershell` uses pwsh. **Part of the dedup key** |
| `async` | `boolean` | `false` | Runs in the background without blocking |
| `asyncRewake` | `boolean` | `false` | Background run that wakes the model on exit code 2 (blocking error); implies `async` |

**`type: "http"` only**

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `url` | `string` (required, URL) | — | URL the hook input JSON is POSTed to |
| `headers` | `object<string,string>` | none | Extra request headers; values may reference env vars as `$VAR_NAME` / `${VAR_NAME}` |
| `allowedEnvVars` | `string[]` | none | Whitelist of env var names that may be interpolated in header values; only listed vars resolve, other `$VAR` references stay empty |

**`type: "prompt"` / `type: "agent"` only (out of scope in v1; schema matches CC)**

| Field | Type | Meaning |
| --- | --- | --- |
| `prompt` | `string` (required) | Prompt for LLM evaluation / what to verify; `$ARGUMENTS` placeholder = the hook input JSON |
| `model` | `string` | Model to use (e.g. `claude-sonnet-4-6`); defaults to the small/fast model (Haiku) |

**Matcher structure**

```
{
  "<Event>": [
    { "matcher": "<pattern>", "hooks": [ <hook>, ... ] },
    ...
  ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `matcher` | `string` | Event match pattern: `*` (or empty) matches all; `A\|B` is an exact pipe list; anything else is a regex. DSH tool names are lowercase; exact matching is case-insensitive |
| `hooks` | `hook[]` | Hooks executed serially when the matcher matches |

Event keys are limited to the CC 27 event names; v1 wires: `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `UserPromptSubmit` / `SessionStart` / `SessionEnd` / `Stop` / `SubagentEnd`.

## CC compatibility boundary

Compatibility with Claude Code stops at **"the config layout follows the CC shape + the protocol can self-contain its decisions"**; CC-specific protocol surfaces are not carried over:

- ✅ Config layout (`matcher[] + hooks[]`, `if`, `shell`, `timeout`, `statusMessage`, `once`), the stdin JSON input / stdout JSON decision output, and the dedup-key semantics — kept, for familiarity and migration.
- ❌ No CC-specific env vars injected (`CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, …) — the project root is already available as `cwd` on the input JSON, and DSH has no plugin/skill dirs to point at.
- ❌ No `${CLAUDE_PLUGIN_ROOT}` string substitution, `CLAUDE_PLUGIN_OPTION_*`, `CLAUDE_ENV_FILE`, or other plugin-hub machinery.
- DSH decisions are consumed directly from the waterfall return values; stdout JSON is just the protocol by which a command hook expresses its own decision (e.g. deny), not "parse output the CC way".

## stdin / stdout protocol (CC-compatible)

**Input** (single-line JSON on the command's stdin):

```json
{
  "session_id": "...",
  "cwd": "F:\\project",
  "hook_event_name": "PreToolUse",
  "tool_name": "read",
  "tool_input": { "path": "..." },
  "tool_use_id": "...",
  "agent_id": "<subagent only>",
  "agent_type": "<subagent only>",
  "delegation_depth": 0
}
```

**Output** (JSON decision on stdout):

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow | deny | ask",
    "permissionDecisionReason": "denied by ...",
    "additionalContext": "..."
  }
}
```

## Development / verification

- Pure-function unit tests: `node --test test/`
- Hot install without restart (when [`dsh-hot-installer`](https://github.com/KYinCode/dsh-hot-installer) is installed): `dsh plugin --profile web add <pkg>@<new-version>` takes effect immediately.
- File log: `~/.dsh/logs/dsh-hooks/dsh-hooks.log`; recent records: `GET /dsh-hooks/recent`.

## Out of scope (boundary)

No uninstall lifecycle, dangling-row reminders, per-session config files, PreCompact/PostCompact, prompt/agent hooks, or a settings UI. The config's lifetime equals its directory's lifetime; if a preset reports `Cannot find package`, the plugin package was likely removed while its preset row remains — remove the row or the preset directory manually.

## License

MIT

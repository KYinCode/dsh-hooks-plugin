# dsh-hooks-plugin

[中文](README.md) | [English](README.en.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 Claude Code 风格的 hooks：在智能体 / 工具生命周期事件上运行 shell 命令，配置来自 `.dsh/hooks.json`（与 Claude Code hooks 兼容的 JSON 结构）。

> 产品名是 **dsh-hooks**；npm / GitHub 包名是 **`dsh-hooks-plugin`**（`dsh-hooks` 已被占用）。运行时 API 与日志路径沿用 `dsh-hooks` 名：`~/.dsh/logs/dsh-hooks/dsh-hooks.log` 与 `GET /dsh-hooks/recent`（见下）。

## 目录

- [特性（v1）](#特性v1)
- [安装](#安装)
- [配置示例](#配置示例)
  - [hook 字段 schema](#hook-字段-schema)
- [CC 兼容边界](#cc-兼容边界)
- [stdin / stdout 协议（CC 兼容）](#stdin--stdout-协议cc-兼容)
- [开发 / 验证](#开发--验证)
- [明确不做（边界）](#明确不做边界)
- [License](#license)

## 特性（v1）

- **四层配置**：全局 `~/.dsh/hooks.json` → 预设 `<preset-dir>/hooks.json` → 项目 `<项目根>/.dsh/hooks.json` → 项目本地 `.dsh/hooks.local.json`。
- **CC 兼容 schema 与协议**：`matcher[] + hooks[]` 结构、stdin JSON 输入 / stdout JSON 决策输出，可复用现有 Claude Code hook 脚本。
- **去重规则对齐 CC 2.1.88 `hookDedupKey`**：`command` = `shell+command+if`、`http` = `url+if`、`prompt/agent` = `prompt+if`；同一 key 跨层只执行一次，最后合并层胜出；`callback/function` 不去重。
- **matcher 语义对齐 CC `matchesPattern`**：`*` 全匹配、`A|B` 管道精确匹配、其余按正则；`if` 条件支持权限规则语法（`Bash(git *)`、`Read(*.ts)`）。
- **事件**：`PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `UserPromptSubmit` / `SessionStart` / `SessionEnd` / `Stop` / `SubagentEnd`。
  - `PreToolUse` 决策 `deny` → 官方工具失败卡片（模型看到 `Error: <reason>`）。
- **子代理**：默认触发，输入载荷携带 `agent_id` / `agent_type` / `delegation_depth`；可用 `subagents: false` 关闭；命令在触发者自己的沙箱上下文执行。
- **热重载**：项目配置改动自动重新加载（`fs.watchFile`），无需重启。
- **免重启热升级**：安装 `dsh-hot-installer` 后，`dsh plugin --profile web add <包>@<新版本>` 当场生效，无需重启。
- **交付形态**：profile bundle（`cordis.patch.yml` 自动插行），用 `dsh plugin --profile <p> add` 安装。

## 安装

```sh
# 从 npm 安装（发布后）
dsh plugin --profile web add dsh-hooks-plugin

# 或本地打包
npm pack
dsh plugin --profile web add ./dsh-hooks-plugin-0.2.3.tgz
```

安装后新会话自动生效；已有会话需要新建（`agent/created` 时按会话接线）。

## 配置示例

`<项目根>/.dsh/hooks.json`：

```json
{
  "PreToolUse": [
    {
      "matcher": "Read|Write|Edit",
      "hooks": [
        {
          "type": "command",
          "command": "echo hook triggered",
          "timeout": 5
        }
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

### hook 字段 schema

每条 hook 是一个对象，`type` 决定判别联合（对齐 CC 2.1.88 `schemas/hooks.ts`）。

**command / prompt / agent / http 公共字段**

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `type` | `"command" \| "http" \| "prompt" \| "agent"` | — | hook 类型。v1 实现 `command` 与 `http`；`prompt`/`agent` 依赖外部 LLM/子代理，v1 不做（`parseHookConfig` 会拒绝未知类型） |
| `if` | `string` | 无 | 权限规则语法过滤器（如 `Bash(git *)`、`Read(*.ts)`），仅工具类事件生效；在 spawn 之前匹配 `tool_name` + `tool_input`，不匹配则不启动进程 |
| `timeout` | `number`（>0） | 60 | 本命令/请求的超时秒数 |
| `statusMessage` | `string` | 无 | **纯展示文案**：hook 运行时在 spinner/列表里显示的自定义状态消息；有则取代 command/url/prompt 作为 hook 显示名，**不参与去重键、不改变执行与决策** |
| `once` | `boolean` | `false` | 为 `true` 时执行一次后从运行期集合移除 |

**`type: "command"` 专用**

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `command` | `string`（必填） | — | 要执行的 shell 命令 |
| `shell` | `"bash" \| "powershell"` | `bash` | shell 解释器；`bash` 用 `$SHELL`（bash/zsh/sh），`powershell` 用 pwsh。**是去重键的一部分** |
| `async` | `boolean` | `false` | 为 `true` 时后台运行、不阻塞主流程 |
| `asyncRewake` | `boolean` | `false` | 后台运行，且退出码为 2 时唤醒模型并注入阻塞错误；隐含 `async` |

**`type: "http"` 专用**

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `url` | `string`（必填，URL） | — | 向其 POST hook 输入 JSON 的地址 |
| `headers` | `object<string,string>` | 无 | 附加请求头；值可用 `$VAR_NAME` / `${VAR_NAME}` 引用环境变量 |
| `allowedEnvVars` | `string[]` | 无 | 允许在 header 值里插值的环境变量名白名单；只列出的变量会被解析，其余 `$VAR` 引用留空 |

**`type: "prompt"` / `type: "agent"` 专用（v1 不做，schema 对齐 CC）**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `prompt` | `string`（必填） | 用 LLM 评估的 prompt / 要验证的内容；`$ARGUMENTS` 占位 = hook 输入 JSON |
| `model` | `string` | 指定模型（如 `claude-sonnet-4-6`）；缺省用小模型 / Haiku |

**matcher 结构**

```
{
  "<Event>": [
    { "matcher": "<模式>", "hooks": [ <hook>, ... ] },
    ...
  ]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `matcher` | `string` | 事件匹配模式：`*`（或空）全匹配；`A\|B` 管道精确匹配；其余按正则。DSH 工具名小写，精确匹配大小写不敏感 |
| `hooks` | `hook[]` | 该 matcher 命中时串行执行的 hook 列表 |

事件 key 限 CC 27 事件名；v1 实际接线：`PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `UserPromptSubmit` / `SessionStart` / `SessionEnd` / `Stop` / `SubagentEnd`。

## CC 兼容边界

与 Claude Code 的兼容**只停留在"配置结构延续 CC 形状 + 协议能自洽表达决策"**；不搬运 CC 专属协议面：

- ✅ 配置结构（`matcher[] + hooks[]`、`if`、`shell`、`timeout`、`statusMessage`、`once`）、stdin JSON 输入 / stdout JSON 决策输出、去重键语义 —— 延用，方便理解与迁移。
- ❌ 不注入 CC 专属环境变量（`CLAUDE_PROJECT_DIR`、`CLAUDE_PLUGIN_ROOT` 等）——项目根已在输入 JSON 的 `cwd` 字段，且 DSH 没有插件/技能目录可指向。
- ❌ 不做 `${CLAUDE_PLUGIN_ROOT}` 字符串替换、`CLAUDE_PLUGIN_OPTION_*`、`CLAUDE_ENV_FILE` 等插件体系机制。
- DSH 内部决策直接消费 waterfall 返回值，stdout JSON 只是让命令 hook 自己表达决策（如 deny）的协议手段，不是"按 CC 输出解析"。

## stdin / stdout 协议（CC 兼容）

**输入**（命令 stdin 单行 JSON）：

```json
{
  "session_id": "...",
  "cwd": "F:\\project",
  "hook_event_name": "PreToolUse",
  "tool_name": "read",
  "tool_input": { "path": "..." },
  "tool_use_id": "...",
  "agent_id": "<仅子代理>",
  "agent_type": "<仅子代理>",
  "delegation_depth": 0
}
```

**输出**（stdout JSON 决策）：

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

## 开发 / 验证

- 纯函数单测：`node --test test/`
- 热装验证（免重启）：`dsh-hot-installer` 已安装时，`dsh plugin --profile web add <包>@<新版本>` 当场生效。
- 文件日志：`~/.dsh/logs/dsh-hooks/dsh-hooks.log`；最近记录：`GET /dsh-hooks/recent`。

## 明确不做（边界）

不实现卸载生命周期、悬空行提醒、会话级配置档、PreCompact/PostCompact、prompt/agent 型 hook、设置页。配置的生命周期 = 它所在目录的生命周期；若某预设报 `Cannot find package`，通常是该插件包已卸载而预设行仍在，请手动移除对应行或删除预设目录。

## License

MIT

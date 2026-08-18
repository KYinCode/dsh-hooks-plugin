# DSH 实现 Claude Code 风格 Hooks 的可行性报告

> 版本：v2（基于 Claude Code 2.1.88 行为逐项核对）
> 核对来源：Claude Code 官方文档与公开行为（本地参考实现，不入库）
> 使用 skill：`cordis-plugin-development`（宿主 Inspect 实时目录核实）

## 0. 结论

- 整体高度可行：Claude Code 27 个 hook 事件中，DSH 宿主能原生承载约 12 个、近似实现 5 个。
- 唯一按用户要求暂缓的缺口：`PreCompact` / `PostCompact`（宿主 `compaction` 服务无事件钩子）。
- DSH 的水瀑布（waterfall）语义比 Claude Code 的"stdout JSON + 退出码"协议更接近第一方能力：可直接改写数据，而无需解析命令输出。
- 建议保持 Claude Code 的 stdin/stdout JSON 协议与配置结构，换取现成 hook 脚本生态的兼容性。

---

## 1. Claude Code 侧的真实模型（源码事实）

### 1.1 完整事件清单：27 个

来源：`src/entrypoints/sdk/coreTypes.ts` 的 `HOOK_EVENTS` 常量（`coreSchemas.ts` 同款）。

```
PreToolUse, PostToolUse, PostToolUseFailure, Notification, UserPromptSubmit,
SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop,
PreCompact, PostCompact, PermissionRequest, PermissionDenied, Setup,
TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult,
ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded,
CwdChanged, FileChanged
```

> 注：早期文档（v1 报告）只列了 8~9 个事件，与当前 2.1.88 源码不符，已按源码更正。

### 1.2 四种 hook 类型

来源：`src/schemas/hooks.ts`（按 `type` 字段判别联合）。

| type | 载荷 | DSH 侧可行性 |
| --- | --- | --- |
| `command` | shell 命令；可选 `shell`(bash/powershell)、`timeout`、`statusMessage`、`once`、`async`、`asyncRewake` | ✅ `shell` / `subprocess` 服务 |
| `prompt` | LLM 评估 prompt（`$ARGUMENTS` 占位，可选 `model`） | ⚠️ 近似：DSH 无"默认小模型评估"内置服务，需另起 LLM 调用 |
| `http` | POST hook 输入 JSON 到 URL（`headers`、`allowedEnvVars`） | ✅ `web` 服务 fetch 能力 |
| `agent` | 代理验证式 hook（`$ARGUMENTS` 占位） | ⚠️ 近似：用 DSH `subagents` 服务起子代理 |

hook 公共字段：`if`（权限规则语法过滤器）、`timeout`（秒）、`statusMessage`、`once`（执行一次后移除）、`async` / `asyncRewake`（后台执行，后者在退出码 2 时唤醒模型并注入阻塞错误）。

### 1.3 两级过滤（matcher 机制）

来源：`src/utils/hooks.ts`（`getMatchingHooks` + `matchesPattern`）、`src/schemas/hooks.ts`（`IfConditionSchema`）。

外层：**`matcher`**（事件组级）——按该事件的匹配字段做模式匹配（见 1.4 表）。

内层：**`if`**（每条 hook 级）——权限规则语法（如 `Bash(git *)`、`Read(*.ts)`），仅对工具类事件生效，在 **spawn 之前**匹配 `tool_name` + `tool_input`，避免为不匹配的命令白启进程。

**matcher 模式类型**（`matchesPattern`，`utils/hooks.ts:1346`）：

| 写法 | 语义 |
| --- | --- |
| 空串 或 `*` | 全部匹配 |
| 纯 `[a-zA-Z0-9_|]+` | 精确匹配；含 `\|` 时为管道多值（`Write\|Edit`），并做 legacy 工具名归一化 |
| 其余 | 按正则（`^Write.*`、`^(Write\|Edit)$`）；正则对 legacy 工具名再测一次；非法正则返回 false |

### 1.4 每个事件的匹配字段

来源：`getMatchingHooks` 的 switch（`utils/hooks.ts:1616`）。

| 事件 | 匹配字段 |
| --- | --- |
| PreToolUse / PostToolUse / PostToolUseFailure / PermissionRequest / PermissionDenied | `tool_name` |
| SessionStart | `source`（startup / resume / clear / compact） |
| PreCompact / PostCompact | `trigger`（manual / auto） |
| Setup | `trigger`（init / maintenance） |
| Notification | `notification_type` |
| SessionEnd | `reason`（exit reason） |
| StopFailure | `error` |
| SubagentStart / SubagentStop | `agent_type` |
| Elicitation / ElicitationResult | `mcp_server_name` |
| ConfigChange | `source`（user_settings / project_settings / local_settings / policy_settings / skills） |
| InstructionsLoaded | `load_reason`（session_start / nested_traversal / path_glob_match / include / compact） |
| FileChanged | `basename(file_path)` |
| **Stop / UserPromptSubmit / CwdChanged / WorktreeCreate / WorktreeRemove / TeammateIdle / TaskCreated / TaskCompleted** | **无匹配字段**（switch default，matchQuery 为 undefined）→ 该事件下所有 hook 无条件执行 |

### 1.5 输入 / 输出协议

- **输入**：hook 输入 JSON 经 **stdin** 传入（每行一条）。公共字段：`session_id`、`transcript_path`、`cwd`、`permission_mode`、`agent_id`（仅子代理）、`agent_type`；再加事件专属字段（如 PreToolUse 的 `tool_name` / `tool_input` / `tool_use_id`）。
- **输出**：结果经 **stdout JSON** 返回。公共字段：
  - `continue`（false 时阻止续跑，配 `stopReason`）
  - `suppressOutput`（隐藏 stdout 转写）
  - `decision`（approve / block，配 `reason`）
  - `systemMessage`（向用户显示警告）
- **每事件 `hookSpecificOutput`**（要点）：
  - PreToolUse：`permissionDecision`（allow / deny / ask）、`permissionDecisionReason`、`updatedInput`（改写工具入参）、`additionalContext`
  - UserPromptSubmit：`additionalContext`
  - SessionStart：`additionalContext`、`initialUserMessage`、`watchPaths`
  - PostToolUse：`additionalContext`、`updatedMCPToolOutput`（改写 MCP 工具输出）
  - PostToolUseFailure：`additionalContext`
  - PermissionDenied：`retry`
  - PermissionRequest：`decision`（allow+`updatedInput`/`updatedPermissions` | deny+`message`/`interrupt`）
  - Elicitation / ElicitationResult：`action`（accept / decline / cancel）+ `content`
  - CwdChanged / FileChanged：`watchPaths`
  - WorktreeCreate：`worktreePath`
- **async 协议**：hook 首行输出 `{"async":true}` 即转入后台执行，主流程不等待。
- **环境变量**：`CLAUDE_PROJECT_DIR`、`CLAUDE_PLUGIN_ROOT`、`CLAUDE_PLUGIN_DATA`、`CLAUDE_ENV_FILE`、`CLAUDE_PLUGIN_OPTION_*` 等。
- **配置合并**：user / project / local / policy 四层 settings 合并；插件与技能可注入各自的 hook matcher。

---

## 2. DSH 宿主侧能力核对（27 事件映射全表）

> 依据宿主 Inspect 实时目录（`Service.listService` / `Event.listEvents`）核实。

| # | CC 事件 | DSH 宿主对应 | 模式 | 可行性 |
| --- | --- | --- | --- | --- |
| 1 | PreToolUse | `tools/pre-execute` | waterfall | ✅ 原生（allow / deny / ask，可改参，`exec.name`=tool_name） |
| 2 | PostToolUse | `tools/post-execute` | waterfall | ✅ 原生（accept / replace / enrich / block 结果） |
| 3 | PostToolUseFailure | `tools/post-execute` 的错误分支（抛错工具仍进此瀑布）+ `agent/error` | emit | ✅ 近似 |
| 4 | Notification | `approval/request`（waterfall）+ 客户端通知 Slot | waterfall | ✅ 对应 |
| 5 | UserPromptSubmit | `agent/inbox/inserted`（含 `UserMessage`） | emit | ✅ 对应 |
| 6 | SessionStart | `agent/session-start`（含 `source`） | emit | ✅ 对应 |
| 7 | SessionEnd | `agent/disposed` / `session/disposed` | emit | ✅ 对应 |
| 8 | Stop | `agent/turn-stopping`（serial，await 于边界提交前，可 `agent.steer()` 阻止） | serial | ✅ 对应 |
| 9 | StopFailure | `agent/error`（turn / step 级错误） | emit | ✅ 近似 |
| 10 | SubagentStart | `subagent/start` | emit | ✅ 原生 |
| 11 | SubagentStop | `subagent/end` | emit | ✅ 原生 |
| 12 | PreCompact | 无（`compaction` 服务无事件钩子） | — | ⏸️ 按用户要求暂缓 |
| 13 | PostCompact | 无 | — | ⏸️ 按用户要求暂缓 |
| 14 | PermissionRequest | `approval/request`（可拦截并直接决策） | waterfall | ✅ 对应 |
| 15 | PermissionDenied | `approval/request` 的 denied 结果观测 | waterfall | ✅ 近似 |
| 16 | Setup | 无对应；可用 `agent/session-start` 首次启动近似 | emit | ⚠️ 近似 |
| 17 | TeammateIdle | 无对应（CC 团队会话专属概念） | — | ❌ 缺失 |
| 18 | TaskCreated | `subagent/start`（DSH 子代理即其"task"）+ `workflow/agent-start` | emit | ⚠️ 近似 |
| 19 | TaskCompleted | `subagent/end` + `workflow/agent-end` | emit | ⚠️ 近似 |
| 20 | Elicitation | `userQuestions` 服务（ask API） | service | ⚠️ 部分 |
| 21 | ElicitationResult | 同上（结果观测） | service | ⚠️ 部分 |
| 22 | ConfigChange | `settings/updated`（含 ns / revision / source） | emit | ✅ 对应 |
| 23 | WorktreeCreate | 无事件（`workspaceRegistry` 有 create 但无事件） | — | ⚠️ 可扩 |
| 24 | WorktreeRemove | 同上 | — | ⚠️ 可扩 |
| 25 | InstructionsLoaded | 无直接事件；`system-prompt/assemble`（waterfall）可近似 | waterfall | ⚠️ 近似 |
| 26 | CwdChanged | 无事件（会话 fork / 工作区切换无宿主通知） | — | ⚠️ 可扩 |
| 27 | FileChanged | 无事件（`fs` 无文件监听事件） | — | ⚠️ 可扩（需自建 watcher，宿主无现成） |

**统计**：✅ 原生/对应 12 个；✅ 近似 5 个；⚠️ 部分/可扩 7 个；⏸️ 暂缓 2 个（#12、#13）；❌ 缺失 1 个（#17 TeammateIdle）。

---

## 3. 关键支撑能力（DSH 宿主实测）

1. **命令执行**：`shell` 服务 —— `resolve()` 施加超时/上限，`run()` 前台、`start()` 后台（`ShellProcess` 增量读取 + kill）；**非零退出码不 reject**，以描述性 `ShellRunResult` 返回，与 CC 的 exit code 语义一致。备选：`subprocess`（spawn / PTY）、`terminals`。
2. **配置加载**：`fs` 服务可读取 `.dsh/hooks.json` 式配置；或向 DSH `settings` 服务注册 namespace。
3. **作用域隔离**：上述事件均为 `Scoped<Agent>` 分发，天然支持"每会话独立 hooks"。
4. **生命周期安全**：waterfall 必须调用/返回 `next()`；异步监听须观察 `exec.signal`（取消传播）；`ctx.on()` 注册随插件停止/更新自动回收。
5. **权限栈**：hook 命令经 `shell` 服务会走 DSH 既有沙箱与权限栈，安全性优于 CC 原生命令执行。

---

## 4. 移植要点

1. **matcher 机制可直接复刻**：`tools/pre-execute` 的 `exec.name` + `exec.args` 与 PreToolUse / PermissionRequest 的 `tool_name` / `tool_input` 同构；`matchesPattern` 的精确/管道/正则逻辑照搬即可；`if` 条件（`Bash(git *)`）按 DSH 工具参数结构实现匹配器，且没有 CC 的 legacy 工具名负担。
2. **协议兼容优先**：建议保留 stdin JSON 输入 + stdout JSON 输出的协议面，使现成 CC hooks 脚本可原样复用；DSH 内部则直接消费 waterfall 返回值（deny / allow / 改写），不解析命令输出。
3. **四种 hook type**：`command`、`http` 为原生能力（`shell` / `web`）；`prompt`、`agent` 需额外设计（DSH 无"默认小模型"内置服务，需另行调用 LLM 或起子代理）。
4. **async 协议**：CC 的 `{"async":true}` 首行 + 后台注册 + `asyncRewake`（退出码 2 唤醒模型）对应 DSH 的 `shell.start()` 后台进程 + 向会话注入通知，可行但需自行实现唤醒注入。
5. **配置分层**：CC 从 user / project / local / policy 四层合并；DSH 侧可先做单层 `.dsh/hooks.json`（结构仿照 `matcher[] + hooks[]`），后续再挂 `settings` 服务。

---

## 5. 缺口清单（排除暂缓项后）

| 事件 | 缺口性质 | 备注 |
| --- | --- | --- |
| TeammateIdle | 缺失（CC 团队会话专属） | 建议直接不实现 |
| WorktreeCreate / WorktreeRemove | 宿主无事件 | 需扩展宿主 composition 或在 `workspaceRegistry` 侧补事件 |
| CwdChanged | 宿主无事件 | 同上 |
| FileChanged | 宿主无事件 | 需自建文件 watcher |
| Elicitation / ElicitationResult | 部分 | 依赖 `userQuestions` 服务与 MCP 交互链，需进一步核实接口 |
| Setup | 无对应 | 用 SessionStart 首次启动近似 |
| prompt / agent 型 hook | 无内置 LLM 小模型服务 | 需另行调用 LLM 或子代理 |

---

## 6. 后续路线（供决策）

1. 界交付形态：动态 Cordis 插件（临时验证）vs 持久化 agent preset / 宿主插件（正式产品）。
2. 先做 `command` + `http` 两类 + 核心事件（PreToolUse / PostToolUse / UserPromptSubmit / SessionStart / SessionEnd / Stop / SubagentStart / SubagentStop），验证协议兼容与 waterfall 阻断语义。
3. 再补 `prompt` / `agent` 型与 `if` 条件匹配器。
4. 最后决策缺失事件的处理方式（扩宿主 / 不实现 / 近似替代）。
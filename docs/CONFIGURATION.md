# dsh-hooks 配置手册

> **这本手册回答四个问题：「怎么配、在哪配」，「有哪些能用」，「stdin / stdout 长什么样」，「不支持什么」。**
> 目标读者：要在项目里接入 hooks 语义，但不想翻源码的用户。
> 描述基线：**`dsh-hooks-plugin@0.2.11`（npm latest，2026-08-19）** 的实际行为——一切以 `index.mjs` 代码为准，本手册不做任何理想化；凡手册与直觉不符的地方，以本文「诚实边界」一节为准。
> 相关文档：`README.md`（安装 / 特性概览 / schema）、`docs/hooks-design.md`（设计定稿）、`docs/hooks-feasibility-report.md`（27 事件映射分析）、`docs/implementation-status.md`（交付状态）。
> 本手册**只描述**，不规定实现；它不随插件代码自动生成，插件升级后如有出入请以后者为准。

## 目录

- [0. 一分钟速查](#0-一分钟速查)
- [1. 怎么配、在哪配](#1-怎么配在哪配)
  - [1.1 四层配置文件](#11-四层配置文件)
  - [1.2 要不要预建目录 / 文件](#12-要不要预建目录--文件)
  - [1.3 合并、去重与执行顺序](#13-合并去重与执行顺序)
  - [1.4 热重载](#14-热重载)
  - [1.5 相对路径怎么解析](#15-相对路径怎么解析)
  - [1.6 什么时候生效（接线时机）](#16-什么时候生效接线时机)
- [2. 有哪些能用](#2-有哪些能用)
  - [2.1 8 个事件：触发时机 × 输入字段](#21-8-个事件触发时机--输入字段)
  - [2.2 DSH 工具名清单（matcher / if 里写什么）](#22-dsh-工具名清单matcher--if-里写什么)
  - [2.3 hook 类型：command / http](#23-hook-类型command--http)
  - [2.4 hook 字段 schema](#24-hook-字段-schema)
  - [2.5 matcher 与 if 语法](#25-matcher-与-if-语法)
- [3. 协议（stdin / stdout）](#3-协议stdin--stdout)
  - [3.1 stdin：输入 JSON 的每事件字段](#31-stdin输入-json-的每事件字段)
  - [3.2 stdout：输出 JSON 全字段](#32-stdout输出-json-全字段)
  - [3.3 async 首行标记](#33-async-首行标记)
  - [3.4 决策只在「触发它的那个事件」里被解释](#34-决策只在触发它的那个事件里被解释)
  - [3.5 调试与观测出口](#35-调试与观测出口)
- [4. 示例库](#4-示例库)
  - [4.1 基础命令钩子（纯通知）](#41-基础命令钩子纯通知)
  - [4.2 决策钩子（deny / ask / additionalContext）](#42-决策钩子deny--ask--additionalcontext)
  - [4.3 http 钩子](#43-http-钩子)
  - [4.4 once：只跑一次](#44-once只跑一次)
  - [4.5 async：首行 `{"async":true}`](#45-async首行-asynctrue)
  - [4.6 subagents: false：子代理不触发](#46-subagents-false子代理不触发)
  - [4.7 从 Claude Code 迁移：改 3 点](#47-从-claude-code-迁移改-3-点)
- [5. 诚实边界：不支持项表](#5-诚实边界不支持项表)
- [6. 写一个 hook 脚本](#6-写一个-hook-脚本)
  - [6.1 三种形态](#61-三种形态)
  - [6.2 读 stdin](#62-读-stdin)
  - [6.3 四条钉死的事实](#63-四条钉死的事实)（顶层无 command / 退出码不 gate / hookEventName 一致性 / 决策放脚本文件）
  - [6.4 决策 JSON 模板](#64-决策-json-模板)
  - [6.5 完整脚本示例](#65-完整脚本示例)
  - [6.6 常见坑](#66-常见坑)

---

## 0. 一分钟速查

| 想知道 | 答案 |
| --- | --- |
| 在哪配 | 4 个文件：`~/.dsh/hooks.json` → `<预设目录>/hooks.json` → `<项目根>/.dsh/hooks.json` → `<项目根>/.dsh/hooks.local.json`，全部**可缺省**、按序合并、同 key 去重（后层胜出）。项目两层**热重载**。 |
| 怎么配 | `{ "事件名": [ { "matcher": "<模式>", "hooks": [ { "type": "command", "command": "<命令>" } ] } ] }`。 |
| 哪些事件能用 | 8 个：`PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `UserPromptSubmit` / `SessionStart` / `SessionEnd` / `Stop` / `SubagentEnd`（其余 CC 事件 key 静默跳过）。 |
| 命令从哪拿 | **输入 JSON 顶层没有 `command`**；脚本从 `tool_input.command` 读（见 [6.3](#63-四条钉死的事实)）。 |
| 怎么拦截 | 脚本 stdout 打决策 JSON（`permissionDecision:"deny"`）。**退出码不 gate**——退出非 0 只记录、不拦截（与 CC 不同）。 |
| 写错会不会报错 | 分情况：未知事件 key / `{"hooks":{}}` 信封 / 非工具事件放错字段 → **静默**；`type` 不是 command/http、command 缺字符串 → **该层被跳过并 warn**。详见 [5](#5-诚实边界不支持项表)。 |

---

## 1. 怎么配、在哪配

### 1.1 四层配置文件

配置是纯 JSON，按「层」组织。四个层从宽到窄、**后层合并进前层**：

| # | 层 | 路径 | 作用域 | 谁来写 | 热重载 | 对应 CC |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 全局 | `~/.dsh/hooks.json`（`DSH_HOME` 变了则按新值） | 所有项目 | 用户手写 / agent 代写 | ❌ 无独立监听（随项目变更重读） | `~/.claude/settings.json` |
| 2 | 预设（模板） | `<预设目录>/hooks.json`（与它的 `agent.cordis.yml` 平级） | 加入该预设的所有会话 | agent 创作预设时写 | ❌ 无独立监听（随项目变更重读） | plugin 内嵌 hooks |
| 3 | 项目 | `<项目根>/.dsh/hooks.json` | 该项目（共享、提交 git） | 用户 / 团队 | ✅ `fs.watchFile` 500ms 轮询 + 300ms 防抖 | `<项目>/.claude/settings.json` |
| 4 | 项目本地 | `<项目根>/.dsh/hooks.local.json` | 该项目（个人，建议 gitignore） | 用户 | ✅ 同上 | `<项目>/.claude/settings.local.json` |

> 路径细节：
> - **全局**：`process.env.DSH_HOME || ~/.dsh` 下的 `hooks.json`。
> - **预设**：不是随便一个目录都是「预设目录」。它是 agent preset 的落盘目录（内含 `agent.cordis.yml`、`preset.yml` 等）；插件运行期经 `agentPresets.composedPreset(agent.ctx)` 解析出会话真正加入的预设，再取其目录下的 `hooks.json`。**你手工放一个任意目录的 hooks.json 不会生效**，除非它真的是一个 preset 目录。
> - **项目**：取会话的 `cwd`（`agent.session.header.cwd`，回退 `agent.header.cwd`）作为项目根，拼 `.dsh/hooks.json`。

### 1.2 要不要预建目录 / 文件

**不需要。** 哪个层文件不存在，哪个层就自动跳过（等于没有该层），不会报错。项目第一次接入时，只创建 `<项目根>/.dsh/hooks.json` 即可，连 `.dsh` 目录都随文件创建自动出现。全局 / 预设层同理。

### 1.3 合并、去重与执行顺序

- **合并顺序**：全局 → 预设 → 项目 → 项目本地。后层**追加**（不覆盖整段配置）。
- **同一事件的 hooks 全部执行**（不是「最近层胜出」）。执行顺序 = **层序 × matcher 声明序 × hooks 数组序**，串行。
- **去重**（对齐 CC 2.1.88 `hookDedupKey`）：同 key 跨层只执行一次，保留**最后合并层**（本地胜出）：
  - `command`：`shell + command + if`（`shell` 缺省 `bash` 也是身份的一部分——`{command:'echo x'}` 与 `{command:'echo x', shell:'powershell'}` 是两条都会跑）
  - `http`：`url + if`
  - `prompt/agent`：`prompt + if`（schema 在但 v1 不实现，见 [5](#5-诚实边界不支持项表)）
  - `callback/function`：不去重
- **`once: true`**：执行一次后从运行期集合移除；每个 agent 控制器一套「已消费集合」，热重载不清除（= 每个控制器生命周期内一次）。

JSON 示例（同一条 `echo x` 命令同时出现在全局和项目层时，最终只跑一次，以项目层那份为准）：

```json
// 项目 .dsh/hooks.json
{ "PreToolUse": [ { "matcher": "*", "hooks": [ { "type": "command", "command": "echo x", "timeout": 5 } ] } ] }
```

### 1.4 热重载

- **项目两层**（`<项目根>/.dsh/hooks.json` 和 `.dsh/hooks.local.json`）由 `fs.watchFile` 以 500ms 间隔轮询、300ms 防抖；文件**增 / 改 / 删**都会触发该项目的每个存活会话**全量重新合并四层**。保存即生效，**不用重启、不用新建会话**。
- **全局层 / 预设层没有独立监听**：这两层的改动只有在「项目层文件被改了一次」（重新合并会带上它们）或「插件热升级 / 进程重启」时才被重新读取。要即时验证全局配置改动，touch 一下项目 hooks.json 即可，或热升级插件。
- registered watcher 按项目根去重：同项目的多个会话共享一个 watcher，改动时扇出刷新。

### 1.5 相对路径怎么解析

- `command` 的**工作目录** = 触发该 hook 的会话的 `cwd`（项目根），回退到 dsh 进程 cwd。
- 因此 `"command": "node hooks/x.cjs"` 里的 `hooks/` 是**相对项目根**解析的（前提是脚本就在 `<项目根>/hooks/` 下）。
- 输入 JSON 里始终带一个 `cwd` 字段，脚本拿到后可用它做最稳的基准（尤其命令用了 `cd` 或绝对路径时）。

### 1.6 什么时候生效（接线时机）

- **新会话**：agent 创建（`agent/created`）时接线，立即生效。
- **同进程热装 / 热升级插件**：插件 `apply()` 遍历 `agents` 注册表为**存活会话补线**（幂等），因此热装后**无需新建会话**。
- **进程重启后继续旧会话**：agent 被重建、重新触发接线，天然生效。
- 断线只可能发生在一处：进程重启后旧会话没有重新打开。

子代理（subagent）呢？见 [2.1](#21-8-个事件触发时机--输入字段) 与 [4.6](#46-subagents-false子代理不触发)：默认**触发**（与父同一套分层配置），可逐 matcher 用 `subagents:false` 关。

---

## 2. 有哪些能用

### 2.1 8 个事件：触发时机 × 输入字段

v1 实际接线的 8 个事件（配置 key 写成下面左列的名字）：

| 事件（配置 key） | DSH 宿主事件 | 触发时机 | 该事件**额外**的输入字段 | matcher 匹配字段 | 子代理 | 这个钩子能干嘛 |
| --- | --- | --- | --- | --- | --- | --- |
| `PreToolUse` | `tools/pre-execute` | **工具执行前**（可拦截） | `tool_name`, `tool_input`, `tool_use_id` | `tool_name` | 触发 | 决策：`deny`→官方失败卡、`ask`→审批通道（策略决定弹不弹窗）、`allow`；`additionalContext` 注入 |
| `PostToolUse` | `tools/post-execute` | 工具**成功返回后** | `tool_name`, `tool_input`, `tool_use_id`, `tool_response` | `tool_name` | 触发 | `additionalContext` 注入；**不阻断** |
| `PostToolUseFailure` | `tools/post-execute`（`result.isError` 分支） | 工具**报错后**（返回 isError） | `tool_name`, `tool_input`, `tool_use_id`, `tool_response` | `tool_name` | 触发 | `additionalContext` 注入；**不阻断** |
| `UserPromptSubmit` | `agent/inbox/inserted` | 用户消息**入队**时 | `prompt` | 无（该事件下全跑） | **默认不触发**（v1 硬编码仅顶层） | `additionalContext` 注入 |
| `SessionStart` | `agent/session-start` | 会话开始 | `source` | `source` | 触发（可 `subagents:false` 关） | `additionalContext` 注入 |
| `SessionEnd` | `agent/disposed` | 会话销毁 | `reason`（v1 固定 `"agent-disposed"`） | `reason` | 触发（可关） | 记录 / 收尾（无注入） |
| `Stop` | `agent/turn-stopping` | 回合停止 | （无额外字段） | 无（全跑） | 触发 | 记录（无注入） |
| `SubagentEnd` | `subagent/end`（按父路由） | 子代理结束（**在委派方**触发） | `agent_id`, `agent_type` | `agent_type` | 委派方自己触发 | 记录 |

**所有事件共有的输入字段**（[3.1](#31-stdin输入-json-的每事件字段) 详解）：
`session_id`（触发者 id）、`cwd`（项目根）、`hook_event_name`（事件名）；若触发者是**子代理**，再加 `agent_id`、`agent_type`、`delegation_depth`。

三个「重要差异」：

1. **UserPromptSubmit 默认只在顶层跑**：子代理 inbox 的投递（初始任务、后续消息、结算通知）都是程序化投递，不是「用户提交」，默认不触发，且 v1 硬编码无法用配置放开。
2. **SessionStart / SessionEnd 子代理也触发**（每个 agent 都是独立会话生命周期），想关用 `subagents:false`。
3. **SubagentEnd 在「委派方」那一侧触发**（子代理召唤孙代理时，子代理作为委派方同样收到）——它的 `session_id` 是委派方会话，`agent_id` 才是结束的那个子代理。

### 2.2 DSH 工具名清单（matcher / if 里写什么）

`PreToolUse` / `PostToolUse` / `PostToolUseFailure` 的 matcher 和 `if` 都按 **DSH 工具名**（= 模型实际可调用的工具名，`tool_name`）匹配。下面是**典型会话（本机 2026-08-19 实测）**的工具名，按类归纳；**工具集随 profile / preset 不同而不同**——以你自己会话里实际出现的 `tool_name` 为准，文档列的只是常用子集。

| 类别 | 工具名（`tool_name`） |
| --- | --- |
| 文件读写 | `read`, `write`, `edit`, `glob`, `grep`（注意 DSH 的 `read` 入参是 **`file_path`** 而非 `path`） |
| Shell 执行 | **`pwsh`**（Windows / 本机）；Unix / macOS 对应是 **`bash`**（`@deepseek-ai/dsh-tool-bash`） |
| 检索 / 网络 | `web_search` |
| 交互 / 决策 | `ask_user_question` |
| 任务 / 编排 | `todo_write`, `subagent`, `subagent_fork`, `interrupt_agent`, `list_agents`, `send_message`, `workflow`, `ralph`, `exit_plan_mode` |
| 目标管理 | `create_goal`, `get_goal`, `update_goal` |
| 后台任务 | `job_output`, `job_list`, `job_kill` |
| 技能 / 图像 | `skill`, `read_image` |
| 动态插件（Cordis） | `cordis_inspect_list`, `cordis_inspect_query`, `cordis_define`, `cordis_run`, … |
| **MCP 工具** | `mcp__<server名>__<工具名>`，例如 `mcp__chrome-devtools__click`、`mcp__chrome-devtools__take_snapshot`、`mcp__chrome-devtools__evaluate_script` |

匹配规则（[2.5](#25-matcher-与-if-语法)）相关要点：

- DSH 工具名**全小写**；精确匹配**大小写不敏感**（写 `Read` / `read` 都行）。
- 想覆盖一个 MCP server 的全部工具，用正则 `mcp__chrome-devtools__.*`（或 `^mcp__chrome-devtools__.*`）；想覆盖所有 MCP 工具，用 `mcp__.*`。
- Unix / Windows 都想要时写成 `bash|pwsh`（管道多值，见 [2.5](#25-matcher-与-if-语法) 与从 CC 迁移的 [4.7](#47-从-claude-code-迁移改-3-点)）。

### 2.3 hook 类型：command / http

| 类型 | 做什么 | v1 支持 |
| --- | --- | --- |
| `command` | 把输入 JSON 写到子进程 **stdin**（一行），执行 shell 命令，**解析其 stdout JSON** 作为决策 | ✅ |
| `http` | 把输入 JSON **POST** 到 `url`（**仅 POST**），解析响应体 JSON 作为决策（headers 可选） | ✅ |
| `prompt` | 用 LLM 评估 prompt（CC 语义） | ❌ schema 在但 v1 **拒绝**（该层被跳过 + warn） |
| `agent` | 代理验证式 hook | ❌ 同上 |

### 2.4 hook 字段 schema

**公共字段（`command` / `http` 都认）**

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `type` | `"command" \| "http"` | — | v1 只认这两个；`prompt`/`agent` 写入会**整层被跳过并 warn** |
| `if` | `string` | 无 | 权限规则语法过滤器（`Read(*.ts)`、`Bash(git *)`），**仅工具类事件**生效；在 spawn 前匹配 `tool_name` + `tool_input`，不匹配不启动 |
| `timeout` | `number`（>0） | `60` | 命令 / 请求的超时**秒数**；超时按失败记录，**不产生 deny 决策** |
| `statusMessage` | `string` | 无 | 纯展示文案（控制台里显示的名字），**不参与去重键、不改变执行与决策** |
| `once` | `boolean` | `false` | 每个 agent 控制器生命周期内执行一次后移除 |

**`type: "command"` 专用**

| 字段 | 说明 |
| --- | --- |
| `command`（必填） | 要执行的 shell 命令；**工作目录 = 会话 cwd**（[1.5](#15-相对路径怎么解析)） |
| `shell` | `"bash"`（默认）\| `"powershell"` | **是去重键的一部分**；⚠️ v1 执行**不按它选解释器**——所有 `command` 一律走 dsh-shell（bash 执行器），写 `"powershell"` 不会真的用 pwsh 运行（见 [5](#5-诚实边界不支持项表)） |
| `async` / `asyncRewake` | schema 保留；**v1 不实现后台执行**（见 [5](#5-诚实边界不支持项表)）；真正的 async 语义走 stdout 首行标记（[3.3](#33-async-首行标记)） |

**`type: "http"` 专用**

| 字段 | 说明 |
| --- | --- |
| `url`（必填，URL） | 接收 POST 的地址；请求体 = 输入 JSON |
| `headers` | 附加请求头；值可用 `$VAR` / `${VAR}` 引用环境变量 |
| `allowedEnvVars` | 允许在 header 值中插值的环境变量名白名单；未列出的 `$VAR` 留空 |

### 2.5 matcher 与 if 语法

```
{
  "<事件>": [
    { "matcher": "<模式>", "subagents": true|false, "hooks": [ <hook>, ... ] },
    ...
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `matcher` | 事件**组级**过滤，匹配该事件的「匹配字段」（[2.1](#21-8-个事件触发时机--输入字段) 第 4 列）：空 / `*` 全匹配；`A\|B` 管道**精确多值**（大小写不敏感，如 `Read\|Write\|Edit`）；其余按**正则**（`^write.*`、`mcp__.*`）。非法正则 = 永不匹配（返回 false），不报错。 |
| `subagents` | 缺省 `true`（子代理**默认触发**）；`false` 时子代理触发的事件**跳过该 matcher** |
| `hooks` | 命中时串行执行的 hook 列表 |

`if`（hook 级，权限规则语法）在 matcher 命中后再筛一次，同样只在工具类事件生效：

| 写法 | 语义 |
| --- | --- |
| `Read` | 工具**通配**（匹配任何 read 调用） |
| `Read(*.ts)` | 工具名 + **内容 glob**：`tool_input` 的任一字符串叶子（递归收集）匹配 `*.ts` 即命中；没有字符串叶子时对输入 JSON 字符串化后测一次 |
| `Bash(git *)` | `pwsh` 的 `command` 含 `git ` 前缀时命中（对 shell 类工具是 `tool_input.command`） |

`matcher` 管「这个事件、这个工具」，`if` 管「这条 hook、这个入参」；两层都过才执行。

> **`if` 里的工具名也要对应当前平台的 shell 工具名**：`Bash(git *)` 只在 Unix 的 `bash` 工具上命中；Windows 上是 `pwsh`，请写 `Pwsh(git *)`（大小写不敏感）。想不区分平台，用 matcher 的 `bash|pwsh` 全收 + `if` 只给一个平台名，或干脆别在 `if` 里写 shell 工具名。（README 里的 `Bash(git *)` 是按 CC/Unix 习惯写的示意。）

---

## 3. 协议（stdin / stdout）

### 3.1 stdin：输入 JSON 的每事件字段

**command 钩子**：输入 JSON 经子进程 **stdin 传入，一行**（`JSON.stringify(input) + "\n"`）。
**http 钩子**：同一份 JSON 作为 POST 请求体。

**所有事件公共字段**：

| 字段 | 说明 |
| --- | --- |
| `session_id` | 触发该 hook 的 agent（会话或子代理）的 id |
| `cwd` | 项目根（相对路径基准） |
| `hook_event_name` | 事件名（如 `PreToolUse`）——**脚本判断自己在哪个事件里的唯一靠得住来源** |
| `agent_id`, `agent_type`, `delegation_depth` | **仅子代理触发时**出现：子代理自身的 id / 类型 / 委派深度；**顶层触发时这三个字段不在输入 JSON 里**（`recent` 记录侧才有 `delegation_depth=0`） |

**工具事件专属**（PreToolUse / PostToolUse / PostToolUseFailure 三者同构）：

```json
{
  "session_id": "session-5ce0…",
  "cwd": "F:\\Project\\MyProj",
  "hook_event_name": "PreToolUse",
  "tool_name": "read",
  "tool_input": { "file_path": "…" },
  "tool_use_id": "…"
}
```

| 字段 | 说明 |
| --- | --- |
| `tool_name` | DSH 工具名（小写） |
| `tool_input` | 工具入参对象（**shell 类工具的 `command` 在这里**，见 [6.3](#63-四条钉死的事实)） |
| `tool_use_id` | 本次工具调用的稳定 id |
| `tool_response` | **仅 PostToolUse / PostToolUseFailure**：工具返回的文本内容拼接（text 块 join `\n`）；失败时是错误文本 |

**非工具事件专属字段**（差异点）：

| 事件 | 专属字段 |
| --- | --- |
| `UserPromptSubmit` | `prompt`（用户消息文本） |
| `SessionStart` | `source`（startup / resume / clear / …） |
| `SessionEnd` | `reason`（v1 固定 `"agent-disposed"`） |
| `Stop` | 无专属字段 |
| `SubagentEnd` | `agent_id`（**结束的子代理 id**）、`agent_type`（子代理类型）；`session_id` 是委派方 |

### 3.2 stdout：输出 JSON 全字段

dsh-hooks 解析 hook 的 **stdout 文本**：

- **以 `{` 开头** → 尝试 JSON.parse；解析失败当纯文本处理。
- **不以 `{` 开头** → 纯文本（只记录，[5](#5-诚实边界不支持项表)）。

决策 JSON 字段（全部可选；你打多少，消费多少）：

```json
{
  "continue": true,
  "suppressOutput": false,
  "systemMessage": "…",
  "decision": "approve",
  "reason": "…",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "…",
    "additionalContext": "…"
  }
}
```

| 字段 | v1 消费行为（钉死的） |
| --- | --- |
| `hookSpecificOutput.permissionDecision` | 仅 **PreToolUse**：`"deny"` → 阻断（官方失败卡，模型看到 `Error: <permissionDecisionReason>`）；`"ask"` → 走 DSH 审批通道（策略决定弹不弹窗；`never` 下确定性拒绝）；`"allow"` → 显式放行 |
| `hookSpecificOutput.permissionDecisionReason` | deny / ask 时的理由文本（deny 无理由时回退 `denied by hook <名字>`） |
| `hookSpecificOutput.additionalContext` | **注入上下文**：作为一条 user 消息注入当前 agent（PreToolUse / PostToolUse / PostToolUseFailure / UserPromptSubmit / SessionStart 都会收集）——这是「故意喂养模型」的通道 |
| `decision` | 顶层 `"block"` → 相当于 deny（配顶层 `reason`） |
| `continue` | `false` → 在 **PreToolUse 决策路径**里等价 deny（配顶层 `reason`）；其他事件不消费 |
| `reason` | block / continue:false 时的理由 |
| `hookSpecificOutput.hookEventName` | **不校验**（见 [6.3](#63-四条钉死的事实) 第 3 条，但你必须写对） |
| `suppressOutput` / `systemMessage` / `stopReason` / `hookSpecificOutput.updatedInput` | **解析进 JSON 但 v1 不消费**（透传到人/日志 = 无动作；见 [5](#5-诚实边界不支持项表)） |

> 聚合语义（PreToolUse 有多条 hook 命中时）：任一 `deny` → deny（第一个 deny 胜出）；否则任一 `ask` → ask；否则放行。`additionalContext` 则**全部收集**后逐条注入。

### 3.3 async 首行标记

stdout **第一行**恰好等于 `{"async":true}`（以第一个非空行为准）→ 该 hook 被判定为 **async**：

- **不参与同步决策**：permissionDecision / decision / continue / additionalContext 全部忽略；
- 在记录与日志里标成 `async=True` / `decision=-`，工具照常放行；
- 后面还可以跟更多输出行（脚本继续跑自己的），但 dsh-hooks 不再等它、不再消费它。

典型用途（[4.5](#45-async首行-asynctrue)）：观测型脚本自己开摆、别拦主流程时，首行打个标记就自己异步去了。

### 3.4 决策只在「触发它的那个事件」里被解释

> 这是理解整个协议的关键，也是很多人踩坑的地方。

hook 的 stdout 只在**它被触发的那个事件处理器**里被解析：

- `PreToolUse` 钩子的 stdout 只在 `tools/pre-execute` 期间解释（所以它能 deny）；
- `PostToolUse` / `PostToolUseFailure` 钩子的 stdout 只在 `tools/post-execute` 期间解释，**只消费 additionalContext**——你在 PostToolUse 里打 `permissionDecision:"deny"` **没有任何拦截效果**；
- `UserPromptSubmit` / `SessionStart` 同理只消费 additionalContext。

换句话说：*决策 JSON 属于哪个事件，由「谁触发了这条 hook」决定，不由 JSON 自己声明*。这正面回答了「hookEventName 写错会不会被当作别人」——不会，但会引起第 [6.3](#63-四条钉死的事实) 第 3 条说的那些麻烦。

### 3.5 调试与观测出口

| 出口 | 内容 |
| --- | --- |
| 浮动控制台（浏览器 🔌 Hooks） | 每次都触发记录：事件、hook 名、耗时、退出码、决策色、stdout 可展开；按当前会话过滤，子代理带 `subagent·dN` 角标、行内显示工具名 |
| 文件日志 | `~/.dsh/logs/dsh-hooks/dsh-hooks.log`，行格式：`[ts] hook <事件> <命令/url> -> <退出码> (<耗时>ms) decision=<决策> reason="…" cwd=… sid=… depth=… [agent=… type=…]`；超 1 MiB 滚成 `.1`（`DSH_HOOKS_MAX_LOG_BYTES` 可调） |
| HTTP 端点 | `GET http://<host>:<port>/dsh-hooks/recent`（最近记录 JSON，`?session=<id>` 过滤到某会话，`all`/缺省=全量）；`/dsh-hooks/health` → `ok` |
| 最近记录持久化 | `~/.dsh/logs/dsh-hooks/recent.jsonl`（JSONL，上限 `DSH_HOOKS_RECENT_MAX` 默认 200），热升级/重启后回填内存 view |

---

## 4. 示例库

以下示例都假设写在 `<项目根>/.dsh/hooks.json`（项目层），命令工作目录 = 项目根。

### 4.1 基础命令钩子（纯通知）

什么都不决策，只是「发生了就记录一条」：

```json
{
  "PreToolUse": [
    { "matcher": "Read|Write|Edit", "hooks": [ { "type": "command", "command": "echo [dsh-hooks] PreToolUse hit", "timeout": 5 } ] }
  ],
  "PostToolUse": [
    { "matcher": "*", "hooks": [ { "type": "command", "command": "echo [dsh-hooks] PostToolUse hit", "timeout": 5 } ] }
  ]
}
```

`echo` 的 stdout 不是 JSON、不以 `{` 开头 → 判为纯文本 → 无决策、无注入，只进日志/控制台。**退出码 0；哪怕把 echo 换成 `exit 1` 也只记录、不拦**（[6.3](#63-四条钉死的事实) 第 2 条）。

### 4.2 决策钩子（deny / ask / additionalContext）

**deny**（在 `tools/pre-execute` 拦截并物化官方失败卡）：

```json
{
  "PreToolUse": [
    {
      "matcher": "Read",
      "hooks": [
        {
          "type": "command",
          "command": "node -e \"process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'blocked by policy'}}))\"",
          "if": "Read(*private*)",
          "timeout": 5
        }
      ]
    }
  ]
}
```

**ask**（走审批通道；策略 `ask` 时弹窗、`never` 时确定性拒绝）：

```json
{ "type": "command",
  "command": "node -e \"process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask',permissionDecisionReason:'please review'}}))\"",
  "if": "Read(*ask-me*)", "timeout": 5, "once": true }
```

**additionalContext**（把钩子产出喂给模型）：

```json
{
  "PostToolUse": [
    { "matcher": "Read",
      "hooks": [
        { "type": "command",
          "command": "node -e \"process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'context-from-posttool-hook'}}))\"",
          "timeout": 5 } ] }
  ]
}
```

> **关于内联 `node -e`**：上面为了可读用了一行。Windows 上这种嵌套引号极易踩坑（外层 `"`、内层 `'`、JSON 转义三重叠加）。**正式的决策逻辑请放进脚本文件**（[6.3](#63-四条钉死的事实) 第 4 条）。

### 4.3 http 钩子

```json
{
  "PreToolUse": [
    {
      "matcher": "Read",
      "hooks": [
        { "type": "http", "url": "http://127.0.0.1:18765/", "if": "Read(*http-deny*)", "timeout": 5 }
      ]
    }
  ]
}
```

服务端（`node test/http-hook-server.mjs 18765` 同款逻辑）：收到 POST（body = 输入 JSON），回决策 JSON（含 `hookSpecificOutput.permissionDecision` / `reason` / `additionalContext`），dsh-hooks 按 [3.2](#32-stdout输出-json-全字段) 消费。判断工具入参时读 **`tool_input.file_path`**（DSH 的 read 用 `file_path`，不是 `path`）。

### 4.4 once：只跑一次

```json
{
  "PreToolUse": [
    { "matcher": "Read",
      "hooks": [ { "type": "command", "command": "node hooks/ask-once.cjs", "if": "Read(*ask-me*)", "once": true, "timeout": 5 } ] }
  ]
}
```

第一次命中 `Read(*ask-me*)` 后该 hook 被消费：同一 agent 控制器后续再读 `*ask-me*` 不再触发。**once 的时钟是「每个 agent 控制器」**：换会话、或热升级导致控制器重建，会再来一次。

### 4.5 async：首行 `{"async":true}`

```json
{
  "PreToolUse": [
    { "matcher": "Read",
      "hooks": [ { "type": "command", "command": "node hooks/async-hook.cjs", "if": "Read(*async-me*)", "timeout": 5 } ] }
  ]
}
```

脚本 `hooks/async-hook.cjs`（Windows 下跑通的最小形态）：

```js
process.stdout.write('{"async":true}\n')
// ……后面想干什么自行异步，dsh-hooks 不再等、不再消费
```

触发后：记录 `async=True decision=-`，读操作照常放行。注意与**配置字段** `"async": true` 区分——那个字段 v1 只是保留、**不做后台执行**（[5](#5-诚实边界不支持项表)）。

### 4.6 subagents: false：子代理不触发

```json
{
  "SessionStart": [
    { "matcher": "*", "subagents": false,
      "hooks": [ { "type": "command", "command": "echo [parent/anysession] SessionStart", "timeout": 5 } ] }
  ],
  "PreToolUse": [
    { "matcher": "Read", "hooks": [ /* 默认子代理也触发 */ ] }
  ]
}
```

`subagents: false` 只作用于**它所在的 matcher**：子代理触发的 `SessionStart` 被跳过去，顶层照跑；不加这个字段的 matcher，子代理照常触发（输入里带 `agent_id` / `agent_type` / `delegation_depth` 供脚本区分）。

### 4.7 从 Claude Code 迁移：改 3 点

CC 的 hooks 配置（`.claude/settings.json` ↔ 插件的 hooks）直接搬过来时，只动 3 个地方：

| # | CC 的写法 | dsh-hooks 的写法 | 为什么 |
| --- | --- | --- | --- |
| 1 | 放在 `.claude/settings.json` / `~/.claude/settings.json` | 放在 `<项目根>/.dsh/hooks.json`（或 `.dsh/hooks.local.json` / `~/.dsh/hooks.json`） | DSH 的配置目录是 `.dsh/`；参考 `dsh-project-mcp-bridge` 同款约定 |
| 2 | 整个文档用 `{ "hooks": { … } }` 信封包着 | **去掉信封**，顶层直接是事件 key（`{ "PreToolUse": […], … }`） | dsh-hooks 顶层只认事件名；`hooks` 这个 key 不是事件，会被静默跳过（[5](#5-诚实边界不支持项表)） |
| 3 | matcher / `if` 写 `Bash` | 写 `bash\|pwsh`（或本机 `pwsh`） | CC 的 shell 工具叫 `Bash`；DSH 的 shell 工具名是 `pwsh`（Windows）/ `bash`（Unix），精确匹配大小写不敏感但名字要对上 |

CC 例 → 迁移后：

```json
// CC：settings.json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "bash ./hooks/safe-rm-guard.sh" } ] } ] } }

// dsh-hooks：.dsh/hooks.json（去信封；Bash -> bash|pwsh）
{ "PreToolUse": [ { "matcher": "bash|pwsh", "hooks": [ { "type": "command", "command": "bash ./hooks/safe-rm-guard.sh", "timeout": 5 } ] } ] }
```

> 再加两个 CC 脚本生态的经典坑，迁移时顺手排掉（详见 [6.3](#63-四条钉死的事实)）：
> - 脚本里**读顶层 `input.command`**（如 CC 生态的 safe-rm-guard）→ 在 DSH 里顶层没有 `command`，请改读 `tool_input.command`。
> - 依赖**退出码门控**（非 0 = 失败、exit 2 = block）→ dsh-hooks 退出码不 gate，请改成打决策 JSON。

---

## 5. 诚实边界：不支持项表

「写了会怎样」列：**静默** = 无 warn、无报错、无效果（最难排查，务必读）；**层跳过** = 该层加载失败，其余层照常，日志有 warn。

| # | 事项 | 写了会怎样 | 说明 |
| --- | --- | --- | --- |
| 1 | 27 个 CC 事件中，除 8 个外的事件 key（`Notification`、`PermissionRequest`、`PermissionDenied`、`PreCompact`、`StopFailure`、`SubagentStart`、`Setup`、`ConfigChange`、`FileChanged` 等） | **静默**：parseHookConfig 对非 8 事件 key 直接 `continue`，无 warn | 配置里写了 `"Notification": [...]` 不会有任何效果；这是 P1 未做 warn 加固的结果，靠本表提示 |
| 2 | `{"hooks": { … }}` 信封 | **静默**：「hooks」 key 不是事件名被跳过 | dsh-hooks 顶层只认事件 key（[4.7](#47-从-claude-code-迁移改-3-点)） |
| 3 | `type: "prompt"` / `type: "agent"` | **层跳过 + warn**：parseHookConfig 拒绝「unsupported hook type」 | schema 字段保留但不实现 |
| 4 | `type: "callback"` / `function`（JS 钩子） | **层跳过 + warn**（同上，非 command/http 一律拒） | 没有 JS 回调钩子面 |
| 5 | `hookSpecificOutput.updatedInput`（改写入参） | **静默**：解析但不消费 | DSH `tools/pre-execute` 本身不支持入参改写，v1 明写跳过 |
| 6 | 配置字段 `async: true` / `asyncRewake: true`（后台执行 + 退出码 2 唤醒） | **静默**：字段保留但 v1 总是同步 `shell.run`；`asyncRewake` 未实现 | 真正的 async 走 stdout 首行 `{"async":true}`（[3.3](#33-async-首行标记)） |
| 7 | `systemMessage` / `suppressOutput` / `stopReason` | **静默**：解析进 JSON 但不消费 | CC 协议字段，v1 无对应宿主侧动作 |
| 8 | SessionStart / UserPromptSubmit 钩子的**纯文本 stdout** 注入模型 | 只记录，**不注入** | CC 会给模型；v1 只注入 `additionalContext`（[3.2](#32-stdout输出-json-全字段)） |
| 9 | 退出码门控（非 0 = 失败、2 = block） | **静默**：退出码只记录，决策只看 stdout JSON | 与 CC 的刻意差异（[6.3](#63-四条钉死的事实) 第 2 条） |
| 10 | 全局 / 预设层的**独立**热重载 | 无：这两层只随「项目层被改」或插件重装才重读 | [1.4](#14-热重载) |
| 11 | 独立会话级配置文件 | **不支持** | CC 无此档；临时用例用项目本地 + `if` 按 `session_id` 匹配即可 |
| 12 | 卸载生命周期 / 悬空行提醒 / 设置页 UI | 无 | hooks.json 生命周期 = 它所在目录的生命周期（README「明确不做」同款） |
| 13 | `CLAUDE_PROJECT_DIR` / `CLAUDE_PLUGIN_ROOT` 等 CC 环境变量 | 不注入 | 项目根已在输入 `cwd`；DSH 没有插件/技能目录可指 |
| 14 | CC 插件体系（`${CLAUDE_PLUGIN_ROOT}` 替换、`CLAUDE_PLUGIN_OPTION_*`、`CLAUDE_ENV_FILE`） | 不实现 | 见 README「CC 兼容边界」 |
| 15 | `shell: "powershell"`（换解释器） | **静默**：`shell` 只参与去重键，v1 执行一律走 dsh-shell（bash）执行器，不按它切换 | [2.4](#24-hook-字段-schema)；想用 pwsh 去匹配 `matcher:"pwsh"` 的 DSH 工具，hook 命令本身仍是 bash 解释器 |

排查口诀：**没效果先查这四样** —— 事件名在不在 8 个里（表 #1）？是不是 `{"hooks":{}}` 信封（#2）？hook 类型是不是 command/http（#3/#4）？决策字段是不是放进了它该在的事件（[3.4](#34-决策只在触发它的那个事件里被解释)）？

---

## 6. 写一个 hook 脚本

> 这一章是「怎么把一条 hook 真正写对」的硬事实集中地。**前四小节是钉死的规则**，后面是模板与坑。

### 6.1 三种形态

| 形态 | 要不要读 stdin | 要不要打 stdout | 例子 |
| --- | --- | --- | --- |
| 纯通知 | 可读可不读 | 不用 | `echo it happened` / 记日志 / 发通知 |
| 读上下文 | 要（JSON.parse） | 不用 | 把 `tool_input` 的内容写进自己的系统 / 触发别的动作 |
| 决策 | 要（尤其读 `tool_input.command`、`session_id`） | **必须打决策 JSON** | deny / ask / additionalContext |

判断「现在是什么事件、在动什么工具」，**只信 stdin 的 `hook_event_name` / `tool_name`**，不要自己猜。

### 6.2 读 stdin

stdin 是**一行 JSON**（`JSON.stringify(input)`）。最小骨架（Node）：

```js
// hooks/guard.cjs
let raw = ''
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  const input = JSON.parse(raw)
  // input.hook_event_name / tool_name / tool_input / cwd / session_id …
  // …判断、决策……
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { /* … */ } }))
})
```

Bash / Python 同理：`cat` 读整行 → JSON.parse。**别假设有现成的 `command` 顶层字段，也别假设参数在某个固定 key**——shell 工具的入参结构见下。

### 6.3 四条钉死的事实

#### ① 顶层没有 `command` 便捷字段（钉死）

hook 输入 JSON 顶层只有 `session_id` / `cwd` / `hook_event_name` / 事件专属字段（[3.1](#31-stdin输入-json-的每事件字段)），**没有 `command`**。

- 想拿「这次在执行什么命令」：读 **`tool_input.command`**（`pwsh` / `bash` 类工具的入参）。
- 反例（踩过的坑）：CC 生态的 `safe-rm-guard.sh` 读顶层 `input.command`，在 DSH 里拿到的是空 → 校验直接废掉。迁移时必须改成 `tool_input.command`。

#### ② 退出码不 gate（钉死）

- dsh-hooks **只用 stdout JSON 表达决策**：想 deny / ask / block / 注入，必须打决策 JSON（[3.2](#32-stdout输出-json-全字段)）。
- **退出码只记录**（进日志/控制台那行的 `-> <exit code>`），**不 gate**：`exit 1` 不会失败、`exit 2` 不会 block；**放行与否只看 stdout JSON**（没打决策 JSON 就默认放行，打了才可能 deny/ask）。
- 这与 Claude Code（非 0 = 失败、exit 2 = block）**是刻意差异**：从 CC 迁来的、靠退出码门控的脚本，必须改成打决策 JSON。

#### ③ hookEventName 一致性（钉死）

- 决策 JSON 里的 `hookSpecificOutput.hookEventName` **不被引擎硬校验**（0.2.11 从 `permissionDecision` / `decision` / `continue` 直接消费），但**它必须与触发事件一致**。两层硬道理：
  1. **决策属于谁由触发器决定，不由 JSON 声明**（[3.4](#34-决策只在触发它的那个事件里被解释)）：PreToolUse 钩子的 JSON 只在 `tools/pre-execute` 解释；PostToolUse 里打 deny 无拦截效果。所以「一致性」的本质 = 哪个事件的钩子，输出就在哪个事件的语义里被消费。
  2. **脚本自身与日志的一致性**：CC 风格脚本常按 `hookEventName` 分支；控制台 / 文件日志显示的是 stdin 的 `hook_event_name`。两者不一致 → 脚本跑错分支，人看到的事件名和你回声的事件名对不上，debug 变解谜。
- 正确姿势：**把 stdin 的 `hook_event_name` 原样回填**到 `hookSpecificOutput.hookEventName`（脚本里 `input.hook_event_name` 直接拿来用），别手写死。

#### ④ 决策逻辑放脚本文件（钉死 / 最佳实践）

- 配置里的 `"command"` 写一行、指向脚本文件：`"command": "node hooks/guard.cjs"`、`"python hooks/notify.py"`、`"bash ./hooks/safe-rm-guard.sh"`。
- 决策逻辑放进脚本，**绕开 Windows 内联 JSON 的引号地狱**（`node -e "…\"…''…\"" ` 三重转义极易错），脚本还能有语法高亮、能单独测、能加依赖。
- 配置保持纯声明：事件 / matcher / if / 一条命令 / timeout。**凡超过一行的逻辑，都是脚本的活。**

### 6.4 决策 JSON 模板

**deny（PreToolUse 挡下工具）**

```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "blocked by project policy"
} }
```

**ask（走审批通道）**

```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "please review this read"
} }
```

**显式 allow**（多条钩子时的显式放行）

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow" } }
```

**注入上下文（PostToolUse / UserPromptSubmit / SessionStart 等）**

```json
{ "hookSpecificOutput": { "hookEventName": "PostToolUse", "additionalContext": "上下文片段，会作为 user 消息注入" } }
```

**顶层 block 风格**（等义的 deny）

```json
{ "decision": "block", "reason": "blocked by script" }
```

**continue:false（PreToolUse 决策路径里等价 deny）**

```json
{ "continue": false, "reason": "stop here" }
```

> 注：`continue:false` 只在 PreToolUse 的决策聚合里读（等价 deny）；不要指望它在 PostToolUse / Stop 等事件里「停住回合」——那些事件不消费它。

**async 首行**（不参与同步决策）

```
{"async":true}
```

### 6.5 完整脚本示例

一个「读命令、拦危险 rm」的最小决策脚本（直接搬 [4.2](#42-决策钩子deny--ask--additionalcontext) 概念到文件里，规避引号坑）：

```js
// hooks/guard.cjs  —— 配置里只需写 "command": "node hooks/guard.cjs"
let raw = ''
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  let input = {}
  try { input = JSON.parse(raw) } catch { /* 拿不到就别决策，放行 */ }
  const cmd = (input.tool_input && input.tool_input.command) || ''   // ← 顶层没有 command！
  if (cmd.trim().startsWith('rm -rf')) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: input.hook_event_name || 'PreToolUse',          // ← 从 stdin 回填
        permissionDecision: 'deny',
        permissionDecisionReason: 'refused to allow `rm -rf`',
      },
    }))
  }
  // 什么都不打 = 放行（allow）。退出码写不写、写几都一样，只记录。
})
```

要点回顾：读 `tool_input.command`（①）；不打决策 JSON 就是放行、退出码随意（②）；`hookEventName` 用 `input.hook_event_name` 回填（③）；决策在文件里、配置只有一行 `node hooks/guard.cjs`（④）。

### 6.6 常见坑

1. **读顶层 `command`** → 恒空（①）。
2. **靠 `exit 2` 拦工具** → 不拦，只是日志里多一个 `2`（②）。
3. **PostToolUse 里打 deny** → 白打，只有 additionalContext 被消费（[3.4](#34-决策只在触发它的那个事件里被解释)）。
4. **`hookEventName` 手写死且写错** → 引擎不报错，但脚本分支 / 日志对不上（③）。
5. **stdout 以 `{` 开头但 JSON 不合法** → 按纯文本处理，无决策、**不报错**；写决策 JSON 前先用 `JSON.parse` 自测。
6. **Windows 上内联 `node -e` 引号转义崩掉** → 决策逻辑挪到脚本文件（④）。
7. **超时**：hook 超时（默认 60s）按失败记录，**不 deny**——想要「超时即拦」请在脚本里自己打 decide JSON。
8. **命令找不到 / shell 服务不可用** → 状态记失败、记录进日志，不会拦工具、不会弹给用户。
9. **改配置没生效** → 先确认改的是**项目两层**（热重载）；全局/预设层需 touch 项目文件或热升级（[1.4](#14-热重载)）；再查 [5](#5-诚实边界不支持项表) 的四个静默点。

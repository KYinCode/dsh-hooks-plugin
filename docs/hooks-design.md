# dsh-hooks 设计文档（v1 定稿）

> 配套：`docs/hooks-feasibility-report.md`（可行性报告，27 事件映射、matcher 机制、协议细节）
> 决策依据：Claude Code 2.1.88 源码 + DSH 当前宿主实时能力目录 + dsh-agent-presets 官方源码/README + 上游讨论

## 1. 目标与范围

在 DSH 上实现 Claude Code 风格的 hooks：注册表工具的执行生命周期上挂接用户脚本，兼容 CC 的 hooks 配置结构与 stdin/stdout JSON 协议。

**范围（第一版）**
- 事件子集：以工具类事件（PreToolUse / PostToolUse）为核心，加会话/回合/子代理类事件。
- hook 类型：`command`、`http` 先行；`prompt`、`agent` 后置（依赖外部 LLM/子代理，另行设计）。
- 分层配置：全局 / 预设 / 项目 / 项目本地 四层文件（见 §3）。

**范围外（刻意不做，见 §6/§8）**：卸载生命周期、悬空行提醒、设置页、会话级配置档、PreCompact/PostCompact。

**核心原则：最小化功能 = 最小化影响。官方刻意不做的，我们也不做；上游问题留给上游。**

## 2. 术语

- **hook 事件**：CC 语义的事件名（PreToolUse、PostToolUse、UserPromptSubmit、SessionStart、SessionEnd、Stop、SubagentStart、SubagentEnd、PermissionRequest 等）。
- **matcher**：事件组级过滤，匹配该事件对应的字段（如工具类事件匹配 tool_name）。
- **if 条件**：hook 级过滤，匹配 tool_name + tool_input（权限规则语法，如 `Bash(git *)`）。
- **层级模型**：全局 → 预设（模板）→ 项目 → 项目本地；另有一个运行时扩展点（动态插件会话内注册）。

## 3. 配置分层（定稿）

| 层级 | 载体 | 作用域 | 作者 | CC 对应 |
| --- | --- | --- | --- | --- |
| 全局 | `~/.dsh/hooks.json` | 所有项目 | 用户手写 / agent 代写 | `~/.claude/settings.json` |
| 预设（模板） | `<preset-dir>/hooks.json`（与 agent.cordis.yml 平级） | 所有加入该预设的会话 | agent 创作预设时写入（hooks_config 工具） | plugin 内嵌 hooks（模板默认值） |
| 项目 | `<项目>/.dsh/hooks.json` | 该项目（共享、提交） | 用户/团队 | `.claude/settings.json` |
| 项目本地 | `<项目>/.dsh/hooks.local.json` | 该项目（个人、gitignore） | 用户 | `.claude/settings.local.json`（Project 作用域的个人覆盖——**非会话级**，见可行性报告 v2 更正） |

**明确不做：独立的会话级配置档。** 理由：CC 无此档；真实用例弱（临时调试可用项目本地 + if 条件匹配 session_id）；会话级注册是运行时能力（动态插件），不是配置档。

**运行时扩展点**：动态 Cordis 插件在会话 scope 内注册 hook 监听器——即"仅本次会话的 hook"，不进配置体系。

### 3.1 配置结构（CC 兼容 schema）

```json
{
  "PreToolUse": [
    {
      "matcher": "Write|Edit",
      "hooks": [
        {
          "type": "command",
          "command": "echo $ARGUMENTS | tee -a /tmp/hook.log",
          "if": "Write(*.ts)",
          "timeout": 10,
          "shell": "bash"
        }
      ]
    }
  ]
}
```

字段对齐 CC 2.1.88：事件 key 限定 27 个事件名；matcher 模式：空/`*` 全匹配、`A|B` 管道精确匹配、其余正则；hook 公共字段 `if / timeout / statusMessage / once / async / asyncRewake`。

### 3.2 合并与执行语义

- 合并顺序：全局 → 预设 → 项目 → 项目本地（后加载仅追加，不覆盖）。
- 同一事件的 hook **全部执行**（非最近层胜出）；决策聚合：任一 deny/block → 阻断；`updatedInput` 按序最后生效；`additionalContext` 全部注入。
- **执行顺序**：层序（全局→预设→项目→本地）→ matcher 声明序 → hooks 数组序，去重后串行执行。
- **去重键（对齐 CC 2.1.88 源码 `hookDedupKey`，按 hook 类型）**：
  - command：`${shell ?? 'bash'}\0${command}\0${if ?? ''}` —— **shell 与 if 都是身份的一部分**，`{command:'echo x', shell:'bash'}` 与 `{command:'echo x', shell:'powershell'}` 是两条 hook 都执行；命令相同但 `if` 不同同样不去重；
  - prompt / agent：`${prompt}\0${if ?? ''}`；http：`${url}\0${if ?? ''}`；
  - callback / function：**不去重**（每个唯一）；
  - 同一 key 跨 settings 层（全局/预设/项目/本地）只执行一次，保留最后合并层（本地胜出）；plugin/skill 来源带 root 前缀，互不去重。
- **`once: true`**：执行一次后从运行期集合移除。
- 生效时机：`agent/created` 时读取合并一次（对齐 CC 的会话快照语义）。
- 项目配置热重载：照搬 dsh-project-mcp-bridge 模式（`fs.watchFile` 500ms 轮询 + 300ms 防抖 + 每项目 watcher 扇出到存活控制器；增删改全量重建；删文件 = 卸载该层），不再作为暂缓项。

## 4. 全局配置选址决策（已定：插件自有文件，不用 settings 服务）

**决策**：全局层使用 `~/.dsh/hooks.json`，不注册进 DSH 官方 `settings` 服务 namespace。

理由：
1. `settings` 服务是单文档、无项目维度——项目/本地档只能是文件，为格式统一，全局档必须同构文件（否则出现"全局文档格式 + 项目文件格式"双格式）。
2. hooks 是 CC 形态的重型嵌套数据，塞进平台设置文档污染平台配置、迁移需转换。
3. settings 服务是给平台管理的配置项用的，不是给插件重型数据的。
4. 损失可接受：缺设置页 UI 与热事件，均可自建（暂缓）；文件监听热重载有标准 fs watch 可做（暂缓）。

**暂缓**：settings 只读镜像合并结果（visibility）——不做。

## 5. 预设层实现（已定：hooks.json 放预设目录，不进 agent.cordis.yml）

- 预设 = 目录：`agent.cordis.yml` + `preset.yml` + 附属资产。`copy()` 整目录复制——hooks.json 随模板分发。
- `agent.cordis.yml` 只放一行**启用** hooks 插件的行；**不**在 YAML 内嵌 hooks 数据（避免"YAML 一套 + JSON 一套"双格式）。
- 创作流程（agent 执行）：
  1. `agentPresets.copy('standard', '<tpl>', 名称)`；
  2. 调用插件提供的 `hooks_config` 工具，写入 `<preset-dir>/hooks.json`（工具负责校验 schema、合并去重）；
  3. `agentPresets.standingKeyFor('<tpl>')` 挂载验证；
  4. 启动真实会话确认。
- 运行时定位：宿主平面的插件在 `agent/created` 时经 `agentPresets.composedPreset(agent.ctx)` 取该 agent 的 preset id，再 `resolve(id)` 得组合文件绝对路径，同目录读 `<preset-dir>/hooks.json`。

## 6. 卸载与生命周期（边界决策，已定）

### 6.1 DSH 官方卸载语义（源码实锤）

| 卸载路径 | 实际行为 | 插件能否介入 |
| --- | --- | --- |
| `agentPresets.remove(id)` | 整目录递归 `rm`（含 hooks.json），无回调；若删的是 default 会顺带 unset 默认值 | 不能 |
| `dsh plugin --profile <p> remove <pkg>` | 原样转发 pnpm，删包 | 不能 |
| `cordis_undefine` | 删除动态插件全部 Package/授权/运行态 | 不能 |

**结论：DSH 卸载是原子、递归、无回调的，插件插不上手，也不需要插上手。**

### 6.2 配置生命周期

**hooks.json 的生命周期 = 它所在目录的生命周期**：删预设目录 → 配置跟着没；删项目/个人文件 → 配置没；插件重装 → 配置复活（若目录还在）。插件不实现任何卸载清理逻辑；所有运行时注册随 fiber/进程销毁自动消失。

### 6.3 悬空行（官方设计行为，我们不做任何处理）

若插件包已卸载而某预设的 `agent.cordis.yml` 仍引用该行：下次挂载报 `Cannot find package`，会话创建回滚。这是**官方刻意设计**：组合文件是纯输入、运行时永不自动改写（write() 覆写为空操作）；broken 预设会列在 roster 带原因上报；坏名字绝不能静默变成"启动不了的 agent"。

**我们的立场**：不实现运行时提醒、不实现清理工具、不实现卸载报告。理由：官方 roster 与挂载错误已指名包名与行；官方承认诊断体验是短板（上游 #880/#1197）但留给上游；我们做运行时提醒会重复报错、与官方未来改进冲突。**只在文档层面写清一句话**（见 6.4）。

### 6.4 边界划分

| 领域 | 归属 | 我们的动作 |
| --- | --- | --- |
| 预设组合文件、包管理、卸载 | 官方领域 | 不碰、不提醒、不扫描 |
| hooks.json 的读写、校验、合并 | 我们领域 | 插件负责；生命周期写档 |
| 卸载文档说明 | 文档 | README 注明："若某预设报 Cannot find package，原因通常是该插件包已卸载而预设行仍在，请手动移除对应行或删除预设目录" |

## 7. 核心技术设计（落地时按此实现）

- **插件形态**：以 profile bundle 安装（`dsh plugin --profile web add <pkg>`，包内 `cordis.patch.yml` 的 `- insert:` 自动插行，宿主平面运行），`agent/created` 时按会话接线；临时验证用动态插件。预设模板层只需 assets（hooks.json），组合行（如需）指向已装包名即可。
- **四个组件**：
  1. 配置加载器：`fs` 读四层文件（会话 cwd 取自 `agent.session.header.cwd`，回退 `agent.header.cwd`）→ 按事件合并 → 校验；
  2. 事件监听器：`ctx.on()` 挂宿主事件（`tools/pre-execute`、`tools/post-execute`、`agent/session-start`、`agent/turn-stopping`、`agent/inbox/inserted`、`subagent/end`、`approval/request` 等，见可行性报告映射表）；
  3. 执行器：`shell` 服务（resolve/run/start）跑 command；`web` 服务 fetch 跑 http；stdin 传 JSON 输入、stdout 解析 JSON 输出（兼容 CC 脚本）；
  4. matcher 引擎：事件字段映射 + 精确/管道/正则匹配 + `if` 权限规则匹配。
- **waterfall 语义**：PreToolUse → `tools/pre-execute` 决策（allow/deny/ask/改参）；PostToolUse → `tools/post-execute` 决策（accept/replace/enrich/block）；监听必须调用并返回 `next()`，异步监听观察 `exec.signal`；`ctx.on()` 注册随停止/更新自动回收。

### 7.1 参考实现：dsh-project-mcp-bridge（已投产的可借鉴架构）

来源：`dsh-project-mcp-bridge`（本地安装于 `~/.dsh/profiles/web/node_modules/`；[GitHub: KYinCode/dsh-project-mcp-bridge](https://github.com/KYinCode/dsh-project-mcp-bridge)）。与本项目同构：宿主插件 + 每项目自定义配置 + 按会话接线，其模式可直接借用。

| 该项目的实现 | 对 dsh-hooks 的指导 |
| --- | --- |
| 会话 cwd 获取：`agent.session.header.cwd`（回退 `agent.header.cwd`），取自事件载荷里的 agent 对象 | **开放问题 #1 已由此关闭**：`agent/created` 载荷的 agent 即携 cwd |
| 项目配置 `<项目根>/.dsh/mcp.json`（文件存在即 opt-in），结构对齐 CC/Cursor/VS Code | hooks 采用同一 `.dsh/` 目录约定（`.dsh/hooks.json`），结构对齐 CC hooks |
| `agent/created` 时 `wireAgent()` 建每 agent 控制器；`agent/disposed` 清理；`ctx.effect` 兜底插件热卸载 | hooks 相同生命周期；监听在 `agent.ctx` 注册 → `Scoped<Agent>` 事件天然按会话隔离 |
| `agent.ctx.tools.register()` 注册进 agent 层（仅该项目会话可见） | hooks 项目层同样注册进 agent 层，遮蔽预设/宿主同名监听 |
| 同名 serverName：上层已有默认跳过，`override:true` 强制覆盖（agent 层遮蔽） | 冲突语义可复用（项目层默认追加；`override` 可演化为 hooks 字段） |
| `fs.watchFile` 500ms 轮询 + 300ms 防抖 + 每项目 watcher 扇出到所有存活控制器；增删改全量重建，不做指纹比对 | **项目配置热重载照搬此模式**（已从"暂缓"转正，见 §3.2） |
| `hasServerTools` 用 `agent.ctx.tools.schemas(agent)` 查 agent 视角的上层注册 | 判断"上层是否已有同名 hook"时同样用 agent 视角，而非全局视角 |
| 信任模型：项目配置 = 可执行内容（同级 package.json scripts）；子进程环境降权（`scrubbedParentEnv()`，剔除凭据形态变量与陈旧 `DSH_*`） | command hook 直接适用：同信任模型声明 + 环境降权 |
| 安装：profile bundle + `cordis.patch.yml` 的 `- insert:` 行，`dsh plugin --profile web add` | **插件本体采用官方 bundle 通道**，无需手改任何组合文件 |

### 7.2 子代理语义（定稿）

**事实层（源码核实）**

1. **CC 侧**：工具类 hook（PreToolUse / PostToolUse / PostToolUseFailure / Permission*）在子代理的工具调用处同样触发；载荷以 `agent_id` / `agent_type` 标记（仅子代理触发时存在）；**没有全局"子代理禁 hook"开关**；SubagentStart / SubagentStop 为子代理专属事件。
2. **DSH 侧（dsh-subagent 委派策略）**：
   - 子代理创建时 `applyChildComposition` 强制**加入父的 agent-preset 组合** → 工具基座 = 全局层 + 父的预设层，与父默认一致；
   - 审批策略强制 `'never'`（**无论父是 ask 还是 never**）→ 子代理的审批请求确定性拒绝，**绝不冒泡到用户**；
   - 只继承父的**显式沙箱覆盖**（`sandboxPolicy.overrideOf()` 快照；部署默认值不复制、动态跟随）；
   - 子代理运行时声明："权限范围在启动时固定、不可从内部放宽、超范围操作自动拒绝、把限制写进回复由父处理"；
   - `toolFilter` 能力：创建时**只能从基座删除**工具，不能添加；persona / maxDepth / outputSchema / model 同样可创建时写死；
   - 父的 **agent 层私有注册不自动继承**（一般机制事实：每 agent 各自布线的插件如 dsh-project-mcp-bridge 会给子代理也各自建控制器，实践中子代理因此拥有同一份项目工具——"自己的副本"而非"继承父的"。**工具的 per-agent 分发是各工具插件提供方自己的职责，hooks 插件不参与**）。

**简化模型（设计用）**

> 子代理与父代理共享同一预设工具基座（默认一致）；父对子的工具操作只有"删"（toolFilter），不能"加"；父 agent 层私有工具不自动继承（机制事实，工具的 per-agent 分发由各工具插件负责，不是本项目工作项）。审批是另一条轴：子代理被强制 never，**需要用户拍板的操作永远由父代理发起**。

**hooks 设计决策**

| 点 | 决定 |
| --- | --- |
| 子代理是否触发 hooks | 默认触发（CC 对齐）；输入载荷带 `agent_id` / `agent_type` / `delegation_depth` 供脚本区分；配置可 `subagents: false` 关闭（每层/每 matcher 粒度） |
| 子代理触发时的执行权限 | hook 命令在**触发者自己的沙箱/审批上下文**执行：子代理 = 继承沙箱 + 审批 never → 需要审批的 hook 步骤确定性拒绝、不上浮 |
| 配置读取 | 子代理读同一份分层配置（cwd 与父相同）；全局/预设/项目/本地同源 |
| 隔离 | 每 agent 各自控制器（§7.1 模式）→ 子代理拥有自己的 hooks 实例，`Scoped<Agent>` 事件只收自己的调用 |

**职责边界（本项目不越界）**：hooks 插件只按 agent 布线**自己的 hooks 控制器**（挂监听、读配置）；**工具的 per-agent 分发是各工具插件提供方自己的职责**（如 dsh-project-mcp-bridge 自行布线），本项目不注册、不代管任何工具。

**事件 × 子代理触发语义**

| CC 事件 | DSH 宿主事件 | 子代理会触发吗 | 处理 |
| --- | --- | --- | --- |
| PreToolUse | `tools/pre-execute` | ✅ 子代理自己的工具调用 | 照常，depth 区分 |
| PostToolUse | `tools/post-execute` | ✅ | 照常 |
| PostToolUseFailure | `tools/post-execute` 错误分支 | ✅ | 照常 |
| Stop | `agent/turn-stopping` | ✅ 子代理有自己的回合 | 照常 |
| SessionStart | `agent/session-start` | ✅ 每个 agent 都是新会话（含子代理） | 照常（可 `subagents: false` 关） |
| SessionEnd | `agent/disposed` | ✅ | 照常（可关） |
| SubagentStart / SubagentEnd | `subagent/start` / `subagent/end` | ✅ 在**委派方**侧触发——子代理召唤孙代理时，它作为委派方同样收到 | 照常 |
| PermissionRequest / PermissionDenied | `approval/request` | ✅ 触发，但结果恒为 rejected（子代理审批 never） | 照常，hook 看到确定性拒绝 |
| UserPromptSubmit | `agent/inbox/inserted` | ⚠️ **默认仅顶层**（depth 0） | 见下 |

**两个特殊决策**

1. **UserPromptSubmit 默认只在顶层触发**：子代理的 inbox 投递（初始任务、后续消息、结算通知）都是程序化投递，不是"用户提交"；照常触发会被结算通知误触发。默认 depth 0，可配置放开。
2. **SessionStart / SessionEnd 照常触发**：每个 agent（含子代理）都是独立会话生命周期；是否被子代理触发由 `subagents: false` 统一管理，默认开。

**子代理触发的处理规则（定稿）**

> 子代理触发的 hooks：照常执行（与顶层同一套 matcher / 合并 / 协议）；输入载荷带 `agent_id` / `agent_type` / `delegation_depth`；命令在子代理自己的沙箱/审批上下文执行（继承沙箱 + 审批 never）；想关用 `subagents: false`（逐层/逐 matcher）；UserPromptSubmit 默认顶层。

### 7.3 呈现层（定稿）

**CC 查证结论（源码）**：CC 的 hook 成功输出（hook_success）**模型与 UI 都不展示**——模型侧仅 SessionStart / UserPromptSubmit 的纯文本输出会注入（`messages.ts:4099`，其余事件 `return []`）；UI 侧 hook_success 渲染为 null，完整输出只进 debug 日志（`AttachmentMessage.tsx:312`）。阻断理由（hook_blocking_error）注入模型。

**我们的方案（对人全展示、对模型筛选）**

对人（UI + 日志，方便 debug）：

| 内容 | 去向 |
| --- | --- |
| 每次 hook 触发记录（事件、hook 名、耗时、退出码） | UI 显示 + 日志 |
| stdout / stderr 全文 | UI 可展开查看 + 日志 |
| 决策结果（允许 / 拒绝 / 改写） | UI 显示 + 日志 |
| 拒绝理由 | UI 高亮 + 日志 |
| 完整历史 | `~/.dsh/logs/dsh-hooks/` 文件日志（追加式，mcp-bridge 模式） |

对模型（筛选，只给三种）：

| 内容 | 给模型？ |
| --- | --- |
| 阻断理由（deny / block） | ✅ 给——否则模型不知道为什么被拦（对齐 CC hook_blocking_error） |
| additionalContext | ✅ 给——故意注入通道（协议） |
| SessionStart / UserPromptSubmit 的纯文本输出 | ✅ 给（对齐 CC 行为） |
| 其他事件的 stdout / stderr | ❌ 不给（只进 UI/日志） |
| 纯记录型成功（脚本没给任何决策） | ❌ 不给（避免噪音） |

**呈现布局（定稿）**

| 情况 | 显示在哪 | 谁做 |
| --- | --- | --- |
| hook 拒绝（deny / block） | **官方工具卡片失败态**——源码核实：pre-execute deny 物化 `isError: true` 结果（`dsh-tools/lib/index.js:3109`），官方对话流天然显示失败，模型看到 "Error: 理由" | 零代码 |
| 成功 / 观察型记录 | `conversation.input.dock` 实时流（默认收起一行："🔌 Hooks (N) + 状态点"，可展开为滚动面板） | 插件 Client 组件 |
| 正在跑 | 同一面板的"运行中"行 | 插件 |
| 阻断提示 | `shell.overlay` toast（可选） | 插件 |
| 全部历史 | `~/.dsh/logs/dsh-hooks/` 文件日志（追加式） | 插件 |

**槽位契约（已核实，`conversation.input.dock`）**：list 槽（replaceRisk: none，scope: session）；现有 occupants：`todo`(order 0)、`goal`(order 10)、`queue`(order 20)——多条目按 order 叠加共存，hooks 流以**新 id**（如 `hooks`，order 30）追加，不替换任何既有条目；ownerProps 提供 `session`（ConversationSnapshot）与 `input`（InputState）点时刻快照。`conversation.input.plan`（plan 状态）在输入框内工具行，`tool.call.toolview`（ask_user_question 等工具卡片）在对话流——均不受影响。

**明确不做**：不注册新视图 Tab（`conversation.view`）；不侵入 `tool.call.toolview`（已有 key 会替换官方卡片）。

**槽位实测记录（动态插件 hkpro-2，已运行验证）**：

- `conversation.input.dock` 注册成功，与既有 occupants（todo/goal/queue）共存，`order: 30` 排最后；
- **组件必须全宽渲染**（`width: 100%` + `boxSizing: border-box`）：内容宽度的小块会左对齐贴在行首，看起来像"屏幕左侧小卡片"；
- 实测几何：横条占满会话栏全宽（本实例 1419px，x=280 起），位于输入框正上方（composerStack 内、composer 之上）；
- **dock 方案因布局位移被否决**：dock 在文档流内，面板高度/宽度变化会把会话历史顶起或留下空白——用户实测确认不可接受；
- **最终改用 `shell.overlay`（浮动层）**：`position: fixed` 不占文档流，尺寸变化零布局影响；
- 客户端授权按浏览器实例生效：批准后的页面才注入，新开的页面需重新授权/激活；
- 更新版本需再次批准（单勾只授权当前版本）。

**UI 形态定稿（实测迭代 v2→v12，用户验收通过）**：

| 参数 | 值 |
| --- | --- |
| 座位 | `shell.overlay`（浮动层，zIndex 9999，fixed 定位 right 20 / bottom 120） |
| 宽度 | **固定 360px**（不随任何状态跳变） |
| 高度 | 外层 maxHeight 340（overflow hidden）；列表区 220px 内部滚动；stdout 区 160px 内部滚动 |
| 拖拽 | **整个头部可拖**（仅按钮除外，`e.target.closest('button')` 排除），pointer capture + transform 位移 |
| 头部 | 🔌 Hooks · N 条 · 最新状态（决策色）· N 拦截（红）· 展开/收起按钮（固定不滚走） |
| 条目行 | 决策图标（✓绿/·灰/✗⛔红）+ 事件（100px 省略号）+ 名称 + 耗时 + 展开按钮（marginLeft auto 靠右，`flexWrap: wrap` 让 stdout 独占下一行、按钮不掉左） |
| stdout | 12px、行高 1.5、pre-wrap 自动换行、深色底、超长内容不截断只滚动 |
| 数据通道 | Host 内存记录（cap 100）→ `harness.handle('hooks/recent')` → Client 1.2s 轮询增量去重（按 id） |
| 长内容实测 | 100+ 字符行、多行输出、长路径均正常换行不截断 |

实现要点：

1. **模型筛选发生在事件监听器内**：hook 执行完，stdout 走 UI/日志通道；`additionalContext` / 拒绝理由走协议注入，其余不进上下文。
2. **"人全展示"= 浮动控制台**（§7.3 UI 定稿形态），全量记录另有文件日志兜底。
3. 与 CC 的差异是刻意的：CC 成功输出对用户也不可见，我们全展示以支持 debug。

## 8. 明确不做清单（防止范围蔓延）

| 事项 | 原因 |
| --- | --- |
| PreCompact / PostCompact | 宿主无事件（用户已暂缓） |
| prompt / agent 型 hook | 宿主无"默认小模型"内置服务，需外部 LLM/子代理，另行设计 |
| 会话级配置档 | 无真实用例，CC 无此档 |
| 运行时卸载提醒 / 清理工具 / 卸载报告 | 官方刻意不做；我们也不做（§6.3） |
| 设置页 UI / hooks 配置可视化 | 非核心价值，暂缓 |

## 9. 开放问题（实现前需确认）

1. **第一版事件覆盖清单**：建议第一版做 7 个核心事件（PreToolUse / PostToolUse / UserPromptSubmit / SessionStart / SessionEnd / Stop / SubagentEnd——全部为"原生对应"级，无需近似），其余按需追加（PostToolUseFailure / StopFailure / PermissionRequest / ConfigChange 等为 v2 候选）。

> 原"hook 顺序与去重"开放问题已关闭：去重键按 hook 类型取（command = shell+command+if；prompt/agent = prompt+if；http = url+if；callback/function 不去重），同一 key 跨层只跑一次、本地胜出；顺序 = 层序 × matcher 序 × 数组序，串行；`once: true` 运行期移除（详见 §3.2）。

> 原"会话工作目录获取"开放问题已关闭：`agent.session.header.cwd`（回退 `agent.header.cwd`），见 §7.1。
# dsh-hooks 复现手册（REPRODUCE）

> 面向"换环境/新会话/给别人复现"的自取验证 checklist。每个章节都给**操作 + 观测命令 + 判定标准**。
> 当前基准：`dsh-hooks-plugin@0.2.11`（npm latest），web profile URL `http://127.0.0.1:3080`。

## 0. 前置检查（一次性）

```powershell
# 1) 版本三连：registry / web profile 实装 / health
npm view dsh-hooks-plugin dist-tags.latest
(Get-Content ($env:USERPROFILE+'\.dsh\profiles\web\node_modules\dsh-hooks-plugin\package.json') | ConvertFrom-Json).version
(Invoke-WebRequest http://127.0.0.1:3080/dsh-hooks/health -UseBasicParsing).Content   # -> ok

# 2) Test 工作区标记文件
Get-ChildItem 'F:\Project\DeepSeekHarness\Test' -File -Name
#   期望: async-hook.cjs / dsh-ask-me.txt / dsh-async-me.txt / dsh-denied-test.txt / dsh-http-deny.txt / dsh-normal.txt
```

不是 0.2.11 就先热升级（免重启）：
```powershell
dsh plugin --profile web add dsh-hooks-plugin@0.2.11
# 成功标志: ~/.dsh/logs/dsh-hot-installer/dsh-hot-installer.log 出现 hot-reloaded (… -> 0.2.11 …)
```

观测命令（随时可跑）：
```powershell
Get-Content ($env:USERPROFILE+'\.dsh\logs\dsh-hooks\dsh-hooks.log') -Tail 30          # fileLog
$e=((Invoke-WebRequest 'http://127.0.0.1:3080/dsh-hooks/recent?session=all' -UseBasicParsing).Content|ConvertFrom-Json).entries
$e | Select-Object -Last 5 | Format-Table event,name,delegation_depth,tool_name,elapsedMs -AutoSize   # recent(全会话)
```

## ① Workspace Write（非 Full access）会话跑 command hook —— 翻案"必须 Full access"

操作：
1. 浏览器 `http://127.0.0.1:3080` → 「新建会话」→「选择工作区」选 **Test**。
2. 确认「访问模式，当前：**Workspace Write**」（新会话默认）。
3. 发送：`读取文件 F:\Project\DeepSeekHarness\Test\dsh-normal.txt，并原样返回其全部内容`。

观测（fileLog 关键行）：
```
hook PreToolUse echo [dsh-hooks] PreToolUse echo-hit -> 0 (3xxms) decision=- cwd=F:\Project\DeepSeekHarness\Test sid=session-… depth=0
```
判定：
- ✅ `status 0`、几百 ms、无 60s 超时、无 `sandbox policy resolve failed` warn → Workspace Write 可正常跑；会话回复正文为 `normal file content`。
- ❌ 反例（旧结论场景，现在看不到）：`status=1 timedOut=true`（60s）或 stderr 含 sandbox → ACL 急切传播慢未自愈，报回开发。

## ② fileLog 身份字段

不看额外操作，任何 hook 触发后看日志尾段：
```
… decision=- cwd=<项目> sid=<会话id> depth=0          # 顶层
… depth=1 agent=<id> type=subagent                    # 子代理触发
```
核对：recent JSON 与 fileLog 字段一致（recent 另有 `root_session_id`、`tool_name`）。

## ③ 子代理触发 hooks：recent / 日志 / 控制台三者一致

操作：任一会话 spawn 一个子代理并让它 `read` 一次文件。
判定：
- `GET /dsh-hooks/recent` 子代理记录：`delegation_depth=1、agent_id=…、agent_type=subagent、root_session_id=<父会话id>`。
- fileLog：`depth=1 agent=… type=subagent`。
- 控制台（0.2.6+）：该行走 `subagent·d1` 角标；且它出现在**父会话视图**下（`root_session_id` 归组）。

## ④ 同进程热升级后存活会话仍接线（apply() 补线，0.2.5+）

操作：
1. 记下 fileLog 尾部时间戳；随便 `read` 一次 → 有新 hook 行。
2. 热升级：`dsh plugin --profile web add dsh-hooks-plugin@0.2.11` → 日志立即出现对每个存活会话一行 `agent session-…: config from …\.dsh\hooks.json`（无需开新会话）。
3. 再 `read` 一次 → hook 行恢复。

判定：第 2 步"apply 后不必重开会话就有 config from …"= 补线生效（实现：`apply()` 遍历 `agents.list()`）。

## ⑤ 控制台按会话过滤、显示标题（0.2.7 / 0.2.9）

操作：页面刷新（F5）→ 底部 🔌 Hooks 浮动控制台 → 在侧栏**切换会话**；点「展开」看明细。
判定：
- 头部显示 `会话·<标题>`（如 `会话·续接dsh-hooks并…`，hover 见完整标题+id）；切换会话即跟随，不再残留上一会话的 hooks。
- 行格式（0.2.11）：`✓ <event> <hook名> <工具名> [subagent·dN] <ms> ▸`——工具名与子代理角标一眼可见。
- 新建会话/未选会话界面显示组合会话（通常空）。

## ⑥ 日志轮转（0.2.7+）

- 阈值默认 1 MiB（`DSH_HOOKS_MAX_LOG_BYTES` 可调）；超过后 `dsh-hooks.log` 改名 `.1` 并开新文件续写。
- 想立刻看效果：`$env:DSH_HOOKS_MAX_LOG_BYTES='500'; node scripts?` 无——直接跑单测覆盖：`node --test test/core.test.mjs` 里有 `fileLog: rotates…` 用例。

## ⑦ recent 落盘 / 热升级回填（0.2.10+）

- 每条记录同步写 `~/.dsh/logs/dsh-hooks/recent.jsonl`（JSONL，限 `RECENT_PERSIST_MAX` 默认 200，`DSH_HOOKS_RECENT_MAX` 可调）。
- 验证回填：升级前看 `recent.jsonl` 行数 N 与内存 recent=N → 热升级后 `GET /dsh-hooks/recent` 立即 = N（不再归 0）。
- 单测：`recent persists to recent.jsonl and re-seeds after a reload`。

## ⑧ 工具名（tool_name，0.2.11+）

record 带 `tool_name`（仅工具事件，来自 hook 输入）；控制台行内显示触发工具。想区分"某事件没有 PreToolUse"是不是正常：看工具名是否匹配该会话 `.dsh/hooks.json` 的 PreToolUse matcher（例：`ask_user_question` 不匹配 `Read|Write|Edit` → 无 PreToolUse 属正常）。

## 发布 + 热装（自动化, 0.2.12+）

```powershell
cd F:\Project\DeepSeekHarness\dssh-hooks
& .\scripts\release.ps1                 # 单测→bump→pack→publish→等传播→热装→断言(版本/health/recent)
& .\scripts\release.ps1 -CheckOnly      # 只查不改
```

## ⑨ ask 决策验证（2026-08-19 实测三条分支）

前置：Test 工作区新会话（默认 Workspace Write），发送 `请用 read 工具读取文件 F:\Project\DeepSeekHarness\Test\dsh-ask-me.txt，并把内容原样返回。`

| 分支 | 现象 |
| --- | --- |
| ask 弹审批 | 界面出现审批卡：`Read dsh-ask-me.txt` + 理由 `please ask` + `允许一次`/`拒绝`；控制台最新决策色=ask |
| 允许一次 | read 放行、文件读回；PostToolUse 触发（recent/log 里 `cwd=Test` 的 PostToolUse） |
| 拒绝 | read 在 PreToolUse 被拦（**无** PostToolUse/Failure）；工具卡 `Error: the user rejected tool "read"`；模型说明无法读取 |

注意：
- 一次 read 会命中**两条** PreToolUse（echo 观测 + ask 闸门）——Test/.dsh/hooks.json 里 PreToolUse 有多条独立规则，CC 语义串行跑全部命中项。
- ask 钩子 `once:true` → 每会话只弹一次；想再测需开新会话。
- **Full access + 审批=never 的会话看不到 ask**：审批侧"永不询问、自动拒绝"，ask 被直接当拒绝处理（不是插件 bug）。

## 坑位提醒

- **热升级会重建模块**：内存 recent 与配置控制器随模块重建重置；recent 已落盘 0.2.10 起回填，但**插件自身钩子/Watcher 需要 apply 补线**（0.2.5 已做）。客户端 bundle 内容变更要 **F5** 才加载（rev 由 `window.__DSH_BOOT__` 决定；即使 rev 不一致，no-cache 也能拉到新文件，功能可用）。
- **npm 传播慢**：`npm view dist-tags.latest` 刚 publish 后可能仍是旧版本导致 `dsh plugin add` 失败——release 脚本已内置等待轮询。
- **端口**：http 钩子测试先 `node test/http-hook-server.mjs 18765`，旧进程先杀。
- **git push 的 stderr** 是 PowerShell 噪音，看 `ref` 行 `main -> main` 即可。
- **审批策略**：当前会话/环境为 never 时，任何 `ask` 决策 = 确定性拒绝（不弹窗）。要验证 ask 弹窗需把审批策略切回 ask。

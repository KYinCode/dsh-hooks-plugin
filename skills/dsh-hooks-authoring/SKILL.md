---
name: dsh-hooks-authoring
description: 编写或调试已安装的 dsh-hooks-plugin 的 hook 脚本。配置在 <项目根>/.dsh/hooks.json，事件挂 PreToolUse/PostToolUse/UserPromptSubmit/SessionStart 等；命令从 tool_input.command 读，决策只能通过 stdout JSON 表达（permissionDecision deny/ask/allow），退出码不 gate，hookEventName 必须回填，Windows 上 command 由 PowerShell 解释且可能被沙箱拦外部 exe。
---

# 编写 dsh-hooks hook 脚本

这个部署里装了 **dsh-hooks-plugin**：它把 Claude Code 风格的 hooks 接到 DSH 的工具/会话生命周期上，配置从 `<项目根>/.dsh/hooks.json` 读取（另有 `~/.dsh/hooks.json` 全局层等，可缺省、按序合并）。本技能的职责是让你**写得对**：把一条 hook 配好、让它能跑、让它的决策真正生效。

> **完整规范 / 边界表在安装包内的 `docs/CONFIGURATION.md`**（本包自带，随发布版本同步）。深度问题以它为准；这里是常踩的硬事实摘要，先读这份就够了。

## 四条钉死的事实

1. **输入顶层没有 `command`**。要检的命令在 `tool_input.command`（`bash`/`pwsh` 这类 shell 工具的入参）。读顶层 `input.command` 永远是空的 → 校验直接废掉。
2. **退出码不 gate**。`exit 2` 不会拦工具；决策只能靠 **stdout JSON**。没输出决策 JSON = 默认放行。
3. **`hookEventName` 回填**。`hookSpecificOutput.hookEventName` 用 stdin 的 `hook_event_name` 原样填，别手写死。
4. **决策放脚本文件**，配置只写一行 `"command": "<一行>"`（别把长逻辑塞进 JSON 的 `command`，Windows 内联引号必炸）。

## 怎么配

`<项目根>/.dsh/hooks.json`（项目层，热重载，保存即生效）：

```json
{
  "PreToolUse": [
    {
      "matcher": "bash|pwsh",
      "hooks": [
        { "type": "command", "command": "& 'F:/项目目录/guard.ps1'", "timeout": 10 }
      ]
    }
  ]
}
```

- 事件 key 只认 8 个：`PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `UserPromptSubmit` / `SessionStart` / `SessionEnd` / `Stop` / `SubagentEnd`。`{"hooks":{...}}` 信封会被静默跳过。
- Windows 的 shell 工具名是 `pwsh`，Unix 是 `bash`；matcher 管道精确匹配 `bash|pwsh`。`if` 用权限规则语法（如 `Read(*.md)`）。

## 决策 JSON（只在 PreToolUse 有拦截效果）

deny（工具被挡，模型看到 `Error: <reason>`）：

```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "请改用单个文件删除或先归档"
} }
```

- `permissionDecision`：`deny`（拦截，官方失败卡）/ `ask`（走审批通道）/ `allow`（显式放行）。
- `permissionDecisionReason` 是**写给模型看的**——拼成 `Error: <reason>` 引导它换正当做法。
- deny/ask 只在 PreToolUse 消费；PostToolUse/SessionStart 等只消费 `additionalContext`。

## Windows / 沙箱的现实（最容易翻车）

- 本机（Windows）的 `command` 由 **Windows PowerShell** 解释，不是 bash。按 PowerShell 语法写：`& '脚本.ps1'`（调用算子）、单引号包路径。
- Workspace Write 等受限沙箱会**拒拉工作区外的外部 exe**（例如 Git Bash，实测报 `Win32 error 5`）→ 决策 hook 命令失败 = 该 hook 静默失效（fail-open，最危险）。
- 稳妥做法：脚本放**工作区内**、**进程内**执行——PowerShell `& '工作区/guard.ps1'`（读 stdin：`[Console]::In.ReadToEnd()`，写 stdout：`[Console]::Out.WriteLine(...)`，记得设 UTF-8）。或 `node`。
- **写完先确认它真的被调用**：让会话跑一条无害命令，去 `GET /dsh-hooks/recent` 看该 hook 记录 `status=0`；否则它根本没在跑。

## 调试出口

- `GET /dsh-hooks/health` → `ok`；`GET /dsh-hooks/recent` 最近记录（含 status/stderr/decision）。
- 文件日志：`~/.dsh/logs/dsh-hooks/dsh-hooks.log`。
- 浏览器 🔌 Hooks 浮动控制台按会话显示每次触发、耗时、退出码、决策色、stdout 可展开。

## 常见坑速查

- 读顶层 `command` → 恒空（见第 1 条）。
- 靠 `exit 2` 拦 → 不拦。
- PostToolUse 里打 deny → 无效。
- stdout 以 `{` 开头但 JSON 非法 → 按纯文本处理，无提示。
- 改配置没生效 → 确认改的是项目两层（热重载）；全局/预设层需 touch 项目文件或升级插件。

---

**再强调一次索引在哪**：上面说的是「最常踩的硬事实」，**完整规范（8 个事件 schema、stdin/stdout 全字段、聚合语义、五条边界表、6 章写的全流程、6.7 Windows 沙箱决策脚本）都在随包发布的 `docs/CONFIGURATION.md`**。需要深度时读它；本技能负责让你一眼抓到最容易错的地方。

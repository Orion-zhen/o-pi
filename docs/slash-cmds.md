# Slash commands

本页只记录 `agent/extensions/` 中通过 `pi.registerCommand()` 注册的命令。命令名注册时不带 `/`，在 Pi 输入框中以 `/命令名` 调用。

## `/tools`

来源：`agent/extensions/cmd-slash-tools.ts`

用途：在 TUI 中打开工具开关列表，启用或禁用当前会话可用工具。

用法：

```text
/tools
```

行为：

- 仅支持 TUI 模式；非 TUI 模式会提示错误。
- 列出 `pi.getAllTools()` 返回的所有工具。
- 切换后立即调用 `pi.setActiveTools()` 生效。
- 当前选择会写入会话分支的 `tools-config` 自定义条目；会话开始或切换分支时按当前分支恢复。
- 恢复时会过滤已不存在的工具名。

## `/system`

来源：`agent/extensions/system-prompt.ts`

用途：在 TUI 中只读查看当前合成后的 system prompt。

用法：

```text
/system
```

行为：

- 仅支持 TUI 模式；非 TUI 模式直接返回。
- 使用 `ctx.getSystemPromptOptions()` 重新构建本项目实际发送给模型的 system prompt。
- 通过 custom UI 展示，不写入会话历史。
- 关闭：`Esc`、`q` 或 `Enter`。
- 滚动：方向键、`PageUp`、`PageDown`、`Home`、`End`。

## `/skill:<name>`

来源：`agent/extensions/skill-context.ts`

用途：host 侧加载 Pi skill，作为 selected context 注入下一次真实模型请求。

用法：

```text
/skill:demo
```

行为：

- 直接读取对应 `SKILL.md` 并写入 session custom entry。
- 命令列表中的 `/skill:<name>` 来自 Pi 内置 skill discovery；执行阶段由本扩展 input hook 接管。
- 不启动模型，不产生 assistant message，不触发 read 工具。
- 成功加载后显示 skill 状态卡片；卡片不进入模型上下文。
- skill body 不进入 system prompt；扫描到 skill 时 `/system` 只显示 `<skill_policy>`。
- 已加载 skill 的 `SKILL.md` 会被 read dedupe 阻止重复读取。

## `/skill`

来源：`agent/extensions/skill-context.ts`

用途：显示或清理当前 skill context。

用法：

```text
/skill
/skill clear
/skill clear demo
/skill clear --all
/skill clear --hard
```

行为：

- 无参数时显示 active、inactive retained 和 hard cleared 状态。
- 默认 lazy deactivate：追加 inactive 状态，保留旧 body 以保护 prompt cache。
- `--hard` 允许后续上下文省略旧 body，不注入 inactive tag，下一轮 cache prefix 可能重算。
- 成功清理后显示 skill 状态卡片；卡片不进入模型上下文。
- 如果连续 load/clear 之间没有真实会话消息，下一轮上下文只包含该段结束时的净 skill 状态。

## `/stats`

来源：`agent/extensions/stats.ts`

用途：在 TUI 只读浮层查看当前会话统计。

用法：

```text
/stats
```

行为：

- 仅支持 TUI 模式；非 TUI 模式提示 `/stats requires TUI mode`。
- 使用 `ctx.getContextUsage()`、`ctx.getSystemPromptOptions()` 和公开 session entries 生成快照。
- 首屏展示当前请求窗口的 context breakdown；分项 token 通过 provider-aware counter 估算，估算值使用 `~` 标记。
- token counter 规则见 [Token Counter](token-counter.md)。
- 成本只显示为 `est`，不代表账单。
- 通过带边框的 custom UI 浮层展示，不写入会话历史，不经过模型。
- 关闭：`Esc`、`q` 或 `Enter`。
- 滚动：方向键、`PageUp`、`PageDown`、`Home`、`End`。

## `/codex-reset-card`

来源：`agent/extensions/codex-reset-card.ts`

用途：查询并显示当前 Codex 重置卡数量、状态和使用时间窗口。

用法：

```text
/codex-reset-card
```

行为：

- 读取 `~/.codex/auth.json` 中的 Codex access token。
- 请求 ChatGPT 重置卡接口，只显示卡片数量、状态、发放时间、到期时间、已用时间或剩余时间。
- 时区来自当前系统 `Intl` 配置。
- TUI 中通过只读浮层展示；非 TUI 模式使用 UI notification 输出。
- 查询结果、错误详情和接口响应不写入会话历史，不进入模型上下文。
- 错误输出会脱敏，不显示 token 或响应正文。
- 关闭：`Esc`、`q` 或 `Enter`。
- 滚动：方向键、`PageUp`、`PageDown`、`Home`、`End`。

## `/reasoning-effort`

来源：`agent/extensions/reasoning-effort.ts`

用途：修改当前会话的推理强度。

用法：

```text
/reasoning-effort
/reasoning-effort <level>
```

可用档位：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`。

行为：

- 无参数时需要 UI，打开选择器后切换。
- 带 `<level>` 时直接调用 `pi.setThinkingLevel()` 生效。
- Pi 会按当前模型能力钳制实际档位；命令完成后提示最终生效值。
- 无效档位不改写当前设置。

## `/agents`

来源：`agent/extensions/subagent.ts`

用途：列出当前可用 subagent，不经过主模型。

用法：

```text
/agents
```

行为：

- 读取 `~/.pi/agent/agents/*.md`。
- 仅在用户配置允许时读取项目 `.pi/agents/*.md`。
- 展示名称、描述、来源、文件路径、模型、实际可用工具、输出模式和是否有写能力。
- 工具列表是 subagent 配置工具与 `pi.getAllTools()` 的交集；被 `/tools` 从主 Agent 停用的工具仍可显示并传给子进程。
- 结果只显示在 UI 中，不写入会话历史，不消耗模型 token。

## `/run`

来源：`agent/extensions/subagent.ts`

用途：按固定 worker pool 运行一个或多个 subagent 任务，不先交给主模型决定。

用法：

```text
/run <agent> "task" | <agent> "task"
```

示例：

```text
/run scout "inspect backend auth" | reviewer "inspect auth tests"
```

行为：

- 支持单引号和双引号。
- `|` 分隔任务段。
- 直接调用 subagent executor。
- 并发数来自 `agent/configs/subagent.jsonc`，默认 `1`。
- 单个任务失败默认不取消其他任务。
- 写能力工具需要确认；无 UI 时拒绝执行。

## `/chain`

来源：`agent/extensions/subagent.ts`

用途：串行运行多个 subagent，后一步可用 `{previous}` 引用前一步结果。

用法：

```text
/chain <agent> "task" | <agent> "task with {previous}"
```

示例：

```text
/chain scout "inspect auth" | planner "create a plan from {previous}"
```

行为：

- 严格串行。
- 某一步失败后停止。
- `{previous}` 受 handoff 字符上限控制；file 输出只传路径、大小和短预览。

## `/subagent-config`

来源：`agent/extensions/subagent.ts`

用途：显示当前 subagent 运行配置摘要。

用法：

```text
/subagent-config
```

行为：

- 展示并发、超时、重试、输出模式、项目 Agent 开关、写确认和默认工具。
- 只显示 UI 通知，不写入会话历史。

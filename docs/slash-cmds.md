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

用途：直接启动一个 subagent，不先交给主模型决定。

用法：

```text
/run <agent> <task>
```

示例：

```text
/run scout inspect the authentication flow
```

行为：

- 解析 agent 名称和后续任务文本。
- 直接调用 subagent executor。
- 写能力工具需要确认；无 UI 时拒绝执行。

## `/parallel`

来源：`agent/extensions/subagent.ts`

用途：按固定 worker pool 并行运行多个 subagent 任务。

用法：

```text
/parallel <agent> "task" | <agent> "task"
```

示例：

```text
/parallel scout "inspect backend auth" | reviewer "inspect auth tests"
```

行为：

- 支持单引号和双引号。
- `|` 分隔任务段。
- 并发数来自 `agent/configs/subagent.jsonc`，默认 `1`。
- 单个任务失败默认不取消其他任务。

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

# Pi 工具提示词字段

Pi 扩展通过 `pi.registerTool()` 注册工具。工具字段会进入两个不同位置：

1. provider-native tool definition：模型实际 tool call 使用的结构化工具定义。
2. Pi system prompt：Pi 默认 system prompt 会读取提示词元数据；本项目的 `system-prompt.ts` 只合成独立 `<tool_policy>`，不重复工具列表。

## 字段说明

### `name`

工具调用名。模型调用工具时使用这个名字，例如 `read`。

位置：

* 进入 provider tool definition。
* 进入 Pi active tools 管理。
* 如果同名注册，会覆盖对应内置工具。

### `label`

工具在 TUI 中显示的短标签。

位置：

* 主要用于界面渲染。
* 不应依赖它影响模型行为。

### `description`

工具能力说明。

位置：

* 进入 provider tool definition，帮助模型判断何时调用工具。
* `pi.getAllTools()` 也会返回该字段。

### `parameters`

工具参数 JSON Schema。

位置：

* 进入 provider tool definition。
* 字段级 `description` 会成为模型可见的参数说明。
* 适合放调用协议、必填字段和字段含义。

### `promptSnippet`

工具的一行摘要。

位置：

* 当工具 active 时，进入 Pi 默认 system prompt 的 `Available tools` 区域。
* 如果省略，自定义工具不会出现在该区域的一行摘要中。
* 本项目合成的 system prompt 不读取该字段；现有值只作为未启用 `system-prompt.ts` 时的 Pi 默认行为。

### `promptGuidelines`

工具使用规则。

位置：

* 当工具 active 时，追加到 Pi 默认 system prompt 的 `Guidelines` 区域。
* Pi 会把这些规则作为扁平 bullet 追加，不按工具分组。
* 每条规则应直接写出工具名，例如 `Use read ...`，不要写 `Use this tool ...`。
* 本项目把它定义为工具贡献给 `<tool_policy>` 的短规则片段；只放长期路由边界，不放 schema、分页、截断或错误恢复流程。

### `execute`

工具运行逻辑。

位置：

* 不进入 system prompt。
* 模型调用工具后由 Pi 执行。
* 返回的 `content` 会作为 tool result 消息回到模型上下文。

## 与 system prompt 的关系

Pi 在 `before_agent_start` 事件中提供：

```ts
event.systemPrompt
event.systemPromptOptions
```

其中 `systemPromptOptions` 包含：

* `selectedTools`
* `toolSnippets`
* `promptGuidelines`
* `customPrompt`
* `appendSystemPrompt`
* `contextFiles`
* `skills`

扩展可以在 `before_agent_start` 返回新的 `systemPrompt`，从而重写或追加默认提示词。但 provider tool definition 仍由 `name`、`description`、`parameters` 等工具定义字段生成，不等同于 system prompt 文本。

本项目的 system prompt 顺序为：`custom_prompt` 或默认 `role`、`tool_policy`、可选 `skill_policy`、`append_system_prompt`、`project_context`、`subagents`、`context`。工具名、description 和参数 schema 由 provider-native tool definition 独立提供；自定义 `SYSTEM.md` 不会移除共享工具策略。

## 设计建议

* 把调用格式放进 `parameters` schema。
* 把工具能力边界放进 `description`。
* 仅在需要兼容 Pi 默认 system prompt 时设置 `promptSnippet`；本项目合成 prompt 不使用它。
* 把工具长期路由规则放进 `promptGuidelines`。
* 把跨工具不变量放进 `<tool_policy>`。
* 把错误恢复、分页和截断下一步放进 tool result。
* 避免在 system prompt 中重复 schema 已表达的字段约束。

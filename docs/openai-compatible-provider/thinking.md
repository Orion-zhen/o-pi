# 思考传递方式

Chat Completions 和 Responses 统一通过 `thinkingPreset` 配置。优先级为 `modelOverrides > models > provider`。省略字段表示继承，均未配置时使用 SDK 默认行为。显式 `auto` 可覆盖上层预设，恢复 SDK 默认行为。

静态模型需显式声明 `reasoning: true`。`thinkingLevelMap` 配置等级可用性和上游值，与传递方式独立。设置页只编辑 `thinkingPreset`，不另外维护格式或协议限制。

## Chat Completions

厂商格式复用 SDK 编码。harness 只在请求时将预设转换为运行时 `compat.thinkingFormat`，不写回文件。

支持 `openai`、`openrouter`、`deepseek`、`together`、`baseten`、`zai`、`qwen`、`chat-template`、`qwen-chat-template`、`string-thinking` 和 `ant-ling`。

`chat-template` 的参数使用原生 `compat.chatTemplateKwargs`，`baseten` 使用 `compat.chatTemplateArgs`。`chat-template-enabled` 和 `chat-template-effort` 分别生成布尔开关模板和 effort 模板，参数展开交给 SDK。未显式映射 `off` 时，effort 模板在关闭思考时省略该参数。

## Responses

`baseten` 和 `chat-template` 仅支持 Chat Completions，下层校验拒绝 Responses 使用这两个预设。其余预设如下：

| 预设 | 请求编码 |
| --- | --- |
| `auto`、`openai` | 保留 SDK 原生 reasoning |
| `none` | 移除思考控制参数，两种 API 均有效 |
| `openrouter` | `reasoning.effort` |
| `deepseek` | `thinking.type` |
| `together` | `reasoning.enabled` |
| `zai` | `thinking.type`，启用时 `clear_thinking: false` |
| `qwen` | `enable_thinking` |
| `qwen-chat-template` | `chat_template_kwargs.enable_thinking` 和 `preserve_thinking` |
| `chat-template-enabled` | `chat_template_kwargs.enable_thinking` |
| `chat-template-effort` | `chat_template_kwargs.reasoning_effort` |
| `string-thinking` | 字符串 `thinking` |
| `ant-ling` | 启用且显式映射时设置 `reasoning.effort` |

`none` 清除思考控制参数，但不禁止模型内部思考，也不改变 `reasoning` 能力声明。清理发生在 `extraBody` 和 `dropParams` 之后。

非标准 Responses 编码只对推理模型生效。启用前清理 SDK 原生思考字段和 `reasoning.encrypted_content`。effort 使用当前模型的 `thinkingLevelMap`。DeepSeek、Together 和 Z.ai 只有显式 `compat.supportsReasoningEffort: true` 时才附带 `reasoning_effort`。

## model-suffix

`thinkingPreset: "model-suffix"` 对两种 API 都有效。

请求使用当前 Pi 等级名生成 `model-id:<level>`，不使用映射值作为后缀。没有 `:off` 变体时关闭思考使用基础模型。显式映射为 `null` 的等级不追加后缀。

仅定义基础模型，不要将路由变体作为 `models` 条目重复注册。GUI 在后缀模式下根据 `/models` 返回的 ID 合并变体，并为已选模型补全 `reasoning` 和 `thinkingLevelMap`。仅返回的后缀默认可用，缺失等级写为 `null`，`xhigh` 和 `max` 同样按实际 ID 启用。存在基础 ID 且没有 `:off` 时，`off` 使用基础 ID。两者均不存在时禁用 `off`。

候选返回或表单字段修改时，harness 提供的补全与字段编辑一次性写入草稿，保存并重载后生效。仅展开模型设置不修改草稿，也不会自动注册未添加的模型。已有配置优先，获取失败不修改能力。需要重新推导已保存的映射时，获取候选后点击「恢复默认映射」。

未提供候选或显式映射时，可用等级遵循 SDK。对于 `reasoning: true` 的模型，未配置映射的 `off`、`minimal`、`low`、`medium` 和 `high` 默认可用，`xhigh` 和 `max` 需显式启用。设置页不额外限制这些等级。手写配置时建议显式声明服务实际支持的等级：

```json
{
  "thinkingPreset": "model-suffix",
  "models": [{
    "id": "local-model",
    "reasoning": true,
    "thinkingLevelMap": {
      "off": "off", "minimal": null, "low": null, "medium": null,
      "high": "high", "xhigh": null, "max": "max"
    }
  }]
}
```

扩展仅包装 `streamSimple`，使用 SDK 限制后的有效思考等级。模型后缀路由在附加参数和删除参数之后运行，并最终清理思考字段。

`defaultThinkingLevel` 只在模型选择事件中应用，恢复会话不覆盖已恢复等级。它不改变模型的推理能力。

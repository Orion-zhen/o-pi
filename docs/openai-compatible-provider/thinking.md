# 思考编码

未配置 `thinkingPreset` 时保留 SDK 原生请求。静态模型需显式声明 `reasoning: true`，可通过原生 `thinkingLevelMap` 配置等级可用性和上游值。

## Chat Completions

普通思考格式直接配置 `compat.thinkingFormat`，例如 `openai`、`deepseek`、`qwen` 或 `chat-template`。需要模板参数时配置 `compat.chatTemplateKwargs`。扩展不再把普通 `thinkingPreset` 翻译成 completions compat。

## Responses 非标准字段

provider 或模型可以配置 `thinkingPreset`：

| 预设 | 请求编码 |
| --- | --- |
| `openai` | 保留 SDK 原生 reasoning |
| `none` | 移除思考相关字段 |
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

非标准转换只对 Responses 推理模型生效。启用前清理 SDK 原生思考字段和 `reasoning.encrypted_content`。effort 使用当前模型的 `thinkingLevelMap`。DeepSeek、Together 和 Z.ai 只有显式 `compat.supportsReasoningEffort: true` 时才附带 `reasoning_effort`。

## model-suffix

`thinkingPreset: "model-suffix"` 对两种 API 都有效。

自动发现中，基础模型与 `:off`、`:minimal`、`:low`、`:medium`、`:high`、`:xhigh`、`:max` 变体同时存在时，扩展折叠这些变体并生成 `thinkingLevelMap`。未知后缀或没有基础模型的 ID 保持原样。

请求使用当前 Pi 等级名生成 `model-id:<level>`，不使用映射值作为后缀。没有 `:off` 变体时关闭思考使用基础模型。显式映射为 `null` 的等级不追加后缀。

自动发现模型的调整应放在 `modelOverrides`。静态配置请仅定义基础模型，并显式填写 `reasoning` 和 `thinkingLevelMap`，不要将路由变体作为原生 `models` 条目重复注册。原生 `models` 会重新加入显式条目并替换同名发现数据。

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

`streamSimple` 使用 SDK 限制后的有效思考等级，低层 `stream` 使用调用方的合法等级。模型后缀路由在附加参数和删除参数之后运行，并最终清理思考字段。

`defaultThinkingLevel` 只在模型选择事件中应用，恢复会话不覆盖已恢复等级。它不改变模型的推理能力。

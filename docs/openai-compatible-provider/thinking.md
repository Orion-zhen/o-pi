# 思考预设

`thinkingPreset` 将 Pi 思考级别转换为上游服务使用的请求字段。该字段可以配置在提供方或模型上，模型配置优先。

## 支持的预设

| 预设 | 开启思考时的主要字段 | 关闭思考时的主要字段 |
| --- | --- | --- |
| `none` | 不添加控制字段 | 不添加控制字段 |
| `openai` | `reasoning_effort`，或 Responses API 的 `reasoning.effort` | 由 Pi 自身行为决定 |
| `openrouter` | `reasoning: { effort }` | `reasoning: { effort: "none" }` |
| `deepseek` | `thinking: { type: "enabled" }` | 默认发送 `thinking: { type: "disabled" }`。`off` 映射为 `null` 时省略 |
| `together` | `reasoning: { enabled: true }` | `reasoning: { enabled: false }` |
| `zai` | `thinking: { type: "enabled", clear_thinking: false }` | `thinking: { type: "disabled" }` |
| `qwen` | `enable_thinking: true` | `enable_thinking: false` |
| `qwen-chat-template` | `chat_template_kwargs.enable_thinking: true`，并设置 `preserve_thinking` | `chat_template_kwargs.enable_thinking: false`，并设置 `preserve_thinking` |
| `chat-template-enabled` | `chat_template_kwargs.enable_thinking: true` | `chat_template_kwargs.enable_thinking: false` |
| `chat-template-effort` | `chat_template_kwargs.reasoning_effort` | 默认发送 `none`。映射为 `null` 时省略 |
| `string-thinking` | `thinking: "<level>"` | `thinking: "none"` |
| `ant-ling` | 显式映射后发送 `reasoning: { effort }` | 不发送控制字段 |

预设只定义请求体编码方式，不保证上游服务支持对应字段。必要时还需配置 `compat`。

## 推导模型的推理能力

模型省略 `reasoning` 时，扩展按以下规则推导：

- 配置了 `defaultThinkingLevel` 或 `thinkingLevelMap` 时，推导为 `true`。
- 两个字段都没有配置时，推导为 `false`。

`reasoning: false` 不能与这两个字段同时使用。例如，扩展会拒绝以下配置：

```jsonc
{
  "reasoning": false,
  "defaultThinkingLevel": "high"
}
```

## 默认级别和级别映射

```jsonc
{
  "id": "reasoning-model",
  "reasoning": true,
  "thinkingPreset": "openrouter",
  "defaultThinkingLevel": "xhigh",
  "thinkingLevelMap": {
    "off": "none",
    "minimal": null,
    "xhigh": "max"
  }
}
```

规则如下：

- `defaultThinkingLevel` 会在模型选择事件触发时设置。
- 恢复会话触发的模型选择事件不会覆盖已恢复的思考级别。
- `thinkingLevelMap` 的键必须是 Pi 支持的思考级别。
- 映射值为 `null` 时，Pi 隐藏对应级别。
- `xhigh` 和 `max` 只有在 `thinkingLevelMap` 中显式配置映射后才可用。
- `defaultThinkingLevel` 必须是当前映射支持的级别。

## Responses API

对于 `openai-responses`，扩展按以下规则处理：

- `openai` 预设保留 Pi 生成的 Responses 思考字段。
- 其他预设会先删除已有的思考字段，再按预设重新编码。
- 重新编码时，扩展会从 `include` 中删除 `reasoning.encrypted_content`。
- `thinkingLevelMap` 的映射值优先于 Pi 的原始级别值。
- 当 `supportsReasoningEffort` 为 `true` 时，`deepseek`、`together` 和 `zai` 还会在启用思考时发送 `reasoning_effort`。

## Responses 配置示例

```jsonc
{
  "providers": {
    "gateway": {
      "baseUrl": "https://example.com/v1",
      "api": "openai-responses",
      "thinkingPreset": "chat-template-effort",
      "models": [
        {
          "id": "model-id",
          "reasoning": true,
          "defaultThinkingLevel": "xhigh",
          "thinkingLevelMap": {
            "off": "disabled",
            "xhigh": "max"
          }
        }
      ]
    }
  }
}
```

完整的 `compat` 合并规则见[Pi 兼容选项](compatibility.md)。

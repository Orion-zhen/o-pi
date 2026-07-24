# Thinking preset

`thinkingPreset` 把 Pi 的 thinking level 转换成上游服务认识的字段。可放在 provider 或 model；model 级配置优先。

## 支持的 preset

| preset | 开启时主要编码 | 关闭时 |
| --- | --- | --- |
| `none` | 不添加控制字段 | 不添加 |
| `openai` | `reasoning_effort` 或 Responses `reasoning.effort` | 由 Pi 原生行为决定 |
| `openrouter` | `reasoning: { effort }` | effort `none` |
| `deepseek` | `thinking: { type: "enabled" }` | `disabled`（若支持） |
| `together` | `reasoning: { enabled: true }` | `false` |
| `zai` | `thinking: { type: "enabled", clear_thinking: false }` | `disabled` |
| `qwen` | `enable_thinking: true` | `false` |
| `qwen-chat-template` | `chat_template_kwargs.enable_thinking` 和 `preserve_thinking` | `false` |
| `chat-template-enabled` | `chat_template_kwargs.enable_thinking` | `false` |
| `chat-template-effort` | `chat_template_kwargs.reasoning_effort` | 默认 `none` 或省略 |
| `string-thinking` | `thinking: "<level>"` | `"none"` |
| `ant-ling` | 显式 map 时发送 `reasoning.effort` | 不发送 |

这些 preset 只是 payload 编码方式，不会自动证明上游真的支持该能力；必要时仍需配置 `compat`。

## Reasoning 推导

model 省略 `reasoning` 时：

- 配置了 `defaultThinkingLevel` 或 `thinkingLevelMap`，推导为 `true`；
- 两者都没有，推导为 `false`。

以下配置冲突并会被拒绝：

```jsonc
{
  "reasoning": false,
  "defaultThinkingLevel": "high"
}
```

## 默认 level 和 level map

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

- `defaultThinkingLevel` 只在用户主动选择模型时设置一次。
- 恢复 session 的 model selection 不会覆盖已恢复的 thinking level。
- `thinkingLevelMap` 的 key 必须是 Pi 支持的 level。
- `null` 会隐藏对应 level。
- `xhigh`/`max` 只有显式 map 后才会出现在可选 level 中。
- default level 必须能通过该 map 验证。

## Responses API

对于 `openai-responses`：

- `openai` preset 保留 Pi 已生成的 Responses thinking payload。
- 其他 preset 会先删除已有的 Responses thinking 字段，再按 preset 重新编码。
- 转换时会清理 `include` 中不适用于当前配置的 `reasoning.encrypted_content`。
- `thinkingLevelMap` 的上游值优先于 Pi level 原文。
- `supportsReasoningEffort` 为 true 时，部分 preset 还会发送 `reasoning_effort`。

## 特殊示例

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

完整 compat 合并规则见 [compatibility.md](compatibility.md)。

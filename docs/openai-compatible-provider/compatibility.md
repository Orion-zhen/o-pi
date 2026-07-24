# Pi compat

`compat` 描述上游 OpenAI-compatible 服务支持哪些 Pi 请求行为。扩展不根据 provider 名称猜测能力，而是使用保守默认值，再应用用户配置。

## 合并顺序

```text
保守默认值
→ thinkingPreset 生成的 compat
→ provider.compat
→ model.compat
```

provider 和 model 的嵌套字段 `openRouterRouting`、`vercelGatewayRouting`、`chatTemplateKwargs` 按子字段合并；model 只覆盖自己提供的子字段。

## 保守默认值

```jsonc
{
  "supportsStore": false,
  "supportsDeveloperRole": false,
  "supportsReasoningEffort": false
}
```

不确定上游能力时，应保持默认值或显式关闭，而不是假设服务兼容 OpenAI。

## 常用字段

| 字段 | 用途 |
| --- | --- |
| `supportsStore` | 是否接受 `store`。 |
| `supportsDeveloperRole` | 是否接受 developer role。 |
| `supportsReasoningEffort` | 是否接受 `reasoning_effort`。 |
| `supportsUsageInStreaming` | 是否接受 streaming usage 选项。 |
| `maxTokensField` | Completions 使用 `max_tokens` 或 `max_completion_tokens`。 |
| `requiresToolResultName` | tool result 是否必须有 name。 |
| `requiresAssistantAfterToolResult` | tool result 后是否需要 assistant 消息。 |
| `requiresThinkingAsText` | 是否把 thinking 转成带分隔符的文本。 |
| `requiresReasoningContentOnAssistantMessages` | replay reasoning assistant 消息时是否补字段。 |
| `thinkingFormat` | thinking 的上游编码格式。 |
| `chatTemplateKwargs` | chat template 请求参数。 |
| `supportsStrictMode` | 是否接受 tool definition 的 strict。 |
| `cacheControlFormat` | 例如 Anthropic prompt cache 标记。 |
| `sessionAffinityFormat` | session affinity header 格式。 |
| `sendSessionAffinityHeaders` | 是否发送 session affinity header。 |
| `supportsLongCacheRetention` | 是否接受长 prompt cache retention。 |
| `deferredToolsMode` | provider 延迟工具序列化模式。 |
| `supportsToolSearch` | Responses API 是否支持客户端 tool search。 |
| `zaiToolStream` | z.ai 是否接受顶层 `tool_stream`。 |

## 路由字段

OpenRouter：

```jsonc
{
  "compat": {
    "openRouterRouting": {
      "allow_fallbacks": true,
      "data_collection": "deny",
      "order": ["provider-a"],
      "only": ["provider-a"],
      "max_price": { "prompt": 1, "completion": 2 }
    }
  }
}
```

Vercel AI Gateway：

```jsonc
{
  "compat": {
    "vercelGatewayRouting": {
      "only": ["anthropic", "openai"],
      "order": ["anthropic", "openai"]
    }
  }
}
```

完整 schema 和所有嵌套字段见 [`agent/models.example.jsonc`](../../agent/models.example.jsonc)。

## API-specific 过滤

`openai-completions` 模型保留 Completions 所需的 compat。`openai-responses` 模型的原生 Pi 元数据只携带 Responses 支持的字段，避免 Chat-only 能力泄漏到 Responses model。

Responses 目前保留的主要字段包括：

- `supportsDeveloperRole`；
- `sessionAffinityFormat`；
- `supportsLongCacheRetention`；
- `supportsToolSearch`。

运行时仍保留 thinking 转换所需的 compat。

## 示例：本地 Chat Completions

```jsonc
{
  "compat": {
    "supportsStore": false,
    "supportsDeveloperRole": false,
    "supportsReasoningEffort": false,
    "supportsUsageInStreaming": true,
    "maxTokensField": "max_tokens"
  }
}
```

不要同时使用已经废弃的 `advanced` 容器或 snake_case 配置字段；配置加载器会明确提示替代写法。

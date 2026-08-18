# Pi compat

`compat` 描述上游 OpenAI-compatible 服务支持哪些 Pi 请求行为。扩展不根据 provider 名称猜测能力，而是使用保守默认值，再把配置原样交给 Pi transport。

## 合并顺序

```text
保守默认值
→ thinkingPreset 生成的 compat
→ provider.compat
→ model.compat
```

顶层字段由后一个值覆盖。对象值按子字段浅合并，因此 `openRouterRouting`、`vercelGatewayRouting`、`chatTemplateKwargs`、`chatTemplateArgs` 以及未来新增的对象字段都可以在 model 层只覆盖部分配置。

## 保守默认值

```jsonc
{
  "supportsStore": false,
  "supportsDeveloperRole": false,
  "supportsReasoningEffort": false
}
```

不确定上游能力时，应保持默认值或显式关闭，而不是假设服务兼容 OpenAI。

## 原生类型和前向兼容

扩展直接使用当前 `@earendil-works/pi-ai` 导出的 `OpenAICompletionsCompat` 与 `OpenAIResponsesCompat` 类型，不维护本地 compat 字段副本。合并后的对象不再按 API 手工裁剪；Completions 和 Responses transport 只读取各自认识的字段。

Pi 当前没有导出 compat 的运行时 schema，因此 JSONC 加载器只校验 `compat` 是对象，未知字段会保留并透传。这意味着升级 Pi 后可以立即使用新增字段，不必同步修改扩展，但拼错的字段名或错误的字段类型也不会在配置加载时被发现。

应以当前 Pi 类型和官方文档为准。下面只列常用字段，不是封闭清单。

### Completions 常用字段

| 字段 | 用途 |
| --- | --- |
| `supportsStore` | 是否接受 `store`。 |
| `supportsDeveloperRole` | 是否接受 developer role。 |
| `supportsReasoningEffort` | 是否接受 `reasoning_effort`。 |
| `supportsUsageInStreaming` | 是否接受 streaming usage 选项。 |
| `supportsFinishReason` | 流式响应是否提供 `finish_reason`。 |
| `maxTokensField` | 使用 `max_tokens` 或 `max_completion_tokens`。 |
| `supportsThinkingTokenBudget` | 是否接受 vLLM `thinking_token_budget`。 |
| `thinkingFormat` | thinking 的上游编码格式。 |
| `chatTemplateKwargs` / `chatTemplateArgs` | chat template 请求参数。 |
| `supportsStrictMode` | 是否接受 tool definition 的 `strict`。 |
| `supportsOpenAIGrammarTools` | 是否接受 OpenAI grammar custom tools。 |
| `cacheControlFormat` | 例如 Anthropic prompt cache 标记。 |
| `sessionAffinityFormat` | session affinity header 格式。 |
| `openRouterRouting` / `vercelGatewayRouting` | gateway 路由参数。 |

### Responses 常用字段

| 字段 | 用途 |
| --- | --- |
| `supportsDeveloperRole` | 是否接受 developer role。 |
| `supportsStrictMode` | 是否支持 strict function tools。 |
| `supportsOpenAIGrammarTools` | 是否支持 grammar custom tools。 |
| `supportsAdditionalTools` | 是否支持 message-anchored `additional_tools`。 |
| `supportsToolSearch` | 是否支持客户端 deferred tool search。 |
| `supportsExplicitPromptCacheMode` | 是否接受 `prompt_cache_options`。 |
| `sessionAffinityFormat` | session affinity header 格式。 |
| `supportsLongCacheRetention` | 是否接受长 prompt cache retention。 |

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

## 示例：本地 Chat Completions

```jsonc
{
  "compat": {
    "supportsStore": false,
    "supportsDeveloperRole": false,
    "supportsReasoningEffort": false,
    "supportsUsageInStreaming": true,
    "supportsFinishReason": false,
    "supportsThinkingTokenBudget": true,
    "maxTokensField": "max_tokens"
  }
}
```

不要同时使用已经废弃的 `advanced` 容器或 snake_case 配置字段；配置加载器会明确提示替代写法。

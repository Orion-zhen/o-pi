# Pi 兼容选项

`compat` 描述上游 OpenAI 兼容服务对 Pi 请求字段和行为的支持情况。扩展不会根据提供方名称推测能力。扩展先应用保守默认值，再把合并后的 `compat` 交给 Pi 传输层。

## 合并顺序

```text
保守默认值
→ thinkingPreset 生成的兼容选项
→ provider.compat
→ model.compat
```

后面的配置覆盖前面的同名顶层字段。对于值为对象的字段，扩展会浅合并其中的子字段。因此，模型可以只覆盖 `openRouterRouting`、`vercelGatewayRouting`、`chatTemplateKwargs` 或 `chatTemplateArgs` 的部分内容。该规则也适用于 Pi 后续新增且值为对象的字段。

## 保守默认值

```jsonc
{
  "supportsStore": false,
  "supportsDeveloperRole": false,
  "supportsReasoningEffort": false
}
```

如果不能确认上游能力，应保留这些默认值或显式关闭对应行为，不要假设服务完全兼容 OpenAI。

## Pi 类型和向前兼容

扩展直接使用当前 `@earendil-works/pi-ai` 导出的 `OpenAICompletionsCompat` 和 `OpenAIResponsesCompat` 类型，不在本地维护字段副本。合并后，扩展不会根据 API 类型裁剪 `compat`。Completions 和 Responses 传输层会分别读取各自支持的字段。

Pi 当前没有导出 `compat` 的运行时校验模式。因此，JSONC 加载器只校验 `compat` 是否为对象，并保留未知字段。升级 Pi 后，可以直接配置 Pi 新增的字段，无需同步修改该扩展。相应地，加载器无法发现拼错的字段名或错误的字段类型。

请以当前 Pi 类型和官方文档为准。下表只列出常用字段，并非完整清单。

### Completions 常用字段

| 字段 | 用途 |
| --- | --- |
| `supportsStore` | 是否接受 `store` |
| `supportsDeveloperRole` | 是否接受 `developer` 角色 |
| `supportsReasoningEffort` | 是否接受 `reasoning_effort` |
| `supportsUsageInStreaming` | 是否接受流式用量选项 |
| `supportsFinishReason` | 流式响应是否提供 `finish_reason` |
| `maxTokensField` | 使用 `max_tokens` 还是 `max_completion_tokens` |
| `supportsThinkingTokenBudget` | 是否接受 vLLM 的 `thinking_token_budget` |
| `thinkingFormat` | 上游思考参数的编码格式 |
| `chatTemplateKwargs` / `chatTemplateArgs` | 对话模板参数 |
| `supportsStrictMode` | 工具定义是否接受 `strict` |
| `supportsOpenAIGrammarTools` | 是否接受 OpenAI 语法约束自定义工具 |
| `cacheControlFormat` | 提示缓存控制格式，例如 Anthropic 格式 |
| `sessionAffinityFormat` | 会话亲和性请求头格式 |
| `openRouterRouting` / `vercelGatewayRouting` | 网关路由参数 |

### Responses 常用字段

| 字段 | 用途 |
| --- | --- |
| `supportsDeveloperRole` | 是否接受 `developer` 角色 |
| `supportsStrictMode` | 是否支持严格模式函数工具 |
| `supportsOpenAIGrammarTools` | 是否支持语法约束自定义工具 |
| `supportsAdditionalTools` | 是否支持绑定到消息的 `additional_tools` 输入项 |
| `supportsToolSearch` | 是否支持由客户端执行的延迟工具搜索 |
| `supportsExplicitPromptCacheMode` | 是否接受 `prompt_cache_options` |
| `sessionAffinityFormat` | 会话亲和性请求头格式 |
| `supportsLongCacheRetention` | 是否接受长时间提示缓存 |

## 路由字段

OpenRouter 配置示例：

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

Vercel AI Gateway 配置示例：

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

## 本地 Chat Completions 示例

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

不要使用已废弃的 `advanced` 容器，也不要对配置字段使用蛇形命名。配置加载器会拒绝旧字段，并指出替代字段。

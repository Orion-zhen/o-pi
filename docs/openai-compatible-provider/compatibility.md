# 兼容选项

`compat` 使用 SDK 原生字段。未填写的选项由 SDK 决定，扩展不注入 `supportsStore`、`supportsDeveloperRole` 或 `supportsReasoningEffort` 默认值。

思考传递方式统一使用 [`thinkingPreset`](thinking.md)。Chat Completions 的自定义模板可配合原生模板参数：

```json
{
  "thinkingPreset": "chat-template",
  "compat": {
    "supportsReasoningEffort": false,
    "chatTemplateKwargs": { "enable_thinking": { "$var": "thinking.enabled" } }
  }
}
```

provider/model compat 遵循 SDK 的合并规则。`chatTemplateKwargs`、`chatTemplateArgs`、`openRouterRouting` 和 `vercelGatewayRouting` 的嵌套属性由 SDK 合并。

显式预设优先于 SDK 检测的思考格式。`chat-template-enabled` 和 `chat-template-effort` 使用固定模板，需要自定义参数时改用 `chat-template`。仅在请求时生成兼容选项，不写回配置。Responses 的非标准预设直接转换请求体。

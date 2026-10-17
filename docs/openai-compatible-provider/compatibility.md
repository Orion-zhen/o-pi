# 兼容选项

`compat` 直接使用 SDK 原生字段。扩展不注入 `supportsStore: false`、`supportsDeveloperRole: false`、`supportsReasoningEffort: false` 或默认思考编码。

未填写的字段由 SDK 决定。只有验证了服务差异后才显式设置兼容选项。

Chat Completions 的思考格式使用 `compat.thinkingFormat`。例如：

```json
{
  "compat": {
    "thinkingFormat": "chat-template",
    "supportsReasoningEffort": false,
    "chatTemplateKwargs": { "enable_thinking": { "$var": "thinking.enabled" } }
  }
}
```

provider/model compat 遵循 SDK 的合并规则。`chatTemplateKwargs`、`chatTemplateArgs`、`openRouterRouting` 和 `vercelGatewayRouting` 的嵌套属性由 SDK 合并，不再由扩展整体替换。

Responses 非标准编码使用 [thinkingPreset](thinking.md)，不自动修改原生 compat。compat 由 SDK 校验和应用，扩展不重复定义 schema。

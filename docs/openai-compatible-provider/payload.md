# 请求体处理

普通 provider 的请求完全由 SDK 构建。仅配置了请求扩展选项时包装原生 API，不替换流式解析、工具转换或用量统计。

处理顺序：

```text
解析 thinkingPreset，Chat Completions 将显式格式转换为 SDK 运行时 compat
-> SDK 合并模型、有效思考等级和单次请求的采样参数
-> SDK 生成请求体
-> 显式配置的 Responses 非标准思考转换
-> provider extraBody
-> provider dropParams
-> model dropParams
-> model-suffix 路由与思考字段清理，或 none 清理思考控制参数
-> 调用方 onPayload（会话在此移除未配置的输出上限）
```

`extraBody` 只能配置在 provider 上，按顶层字段覆盖。`dropParams` 可配置在 provider、`models` 或 `modelOverrides` 中。模型条目和模型覆盖同时配置时，以 `modelOverrides` 中的列表为准。

两者均不能修改核心字段：

```text
model, messages, input, tools, stream
```

最大输出令牌数使用原生 `maxTokens`，且必须大于 `0`。对于 `models.json` 中配置的服务，Chat Completions 和 Responses 会话请求在模型定义及覆盖均未指定 `maxTokens` 时，移除 SDK 补出的 `max_tokens`、`max_completion_tokens` 和 `max_output_tokens`，由服务端决定输出上限。清空覆盖项仍会继承模型定义中的显式值。此规则不改变 SDK 内部模型元数据，也不改变压缩、标题生成等独立请求的预算。

采样参数使用 `samplingParams` 和 `samplingParamsByThinkingLevel`，例如 `top_p`、`top_k`。不要把模型、消息、工具或令牌上限放进采样参数。

`timeoutMs` 和 `maxRetries` 是扩展的请求默认值，调用方显式选项优先。它们不控制模型目录请求。调用方的取消信号和 SDK 观察钩子保持传递。

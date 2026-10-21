# 请求体处理

普通服务由 SDK 构建请求。配置扩展选项后，包装器调整请求字段，流式解析、工具转换和用量统计继续使用 SDK。

## 顺序

```text
解析 thinkingPreset 与运行时 compat
-> SDK 合并模型、等级和单次请求采样参数
-> SDK 生成请求体
-> Responses 非标准思考转换
-> provider extraBody
-> provider dropParams
-> model dropParams
-> model-suffix 路由或 none 清理
-> 调用方 onPayload
```

会话通过 onPayload 移除未显式配置的输出上限。

## 参数

extraBody 只放在 provider，按顶层字段覆盖。dropParams 可放在 provider、models 或 modelOverrides，模型覆盖列表优先于模型定义。

核心字段 model、messages、input、tools 和 stream 受保护。

maxTokens 使用原生模型字段，须大于 0。模型定义和覆盖均未设置时，Chat Completions 与 Responses 会话移除 SDK 补出的输出上限，由服务端决定。压缩和标题等独立请求使用自己的预算。

采样参数放入 samplingParams 和 samplingParamsByThinkingLevel，例如 top_p、top_k。

timeoutMs 和 maxRetries 设置流式请求默认值，单次请求选项优先。模型目录查询使用独立超时。取消信号和 SDK 观察钩子沿调用链传递。

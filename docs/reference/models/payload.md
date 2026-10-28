# 请求体处理

SDK 负责认证、协议分派、请求构造和响应解析。opi 通过 `before_provider_request` 会话事件调整 payload，不注册或替换 provider。

## 顺序

```text
SDK 构造原生 payload
-> provider extraBody
-> provider dropParams
-> 有效模型 dropParams
-> OpenAI 未显式配置时移除输出上限
```

`extraBody` 只放在 provider，按顶层字段覆盖，不递归合并。`dropParams` 可放在 provider、models 或 modelOverrides，模型覆盖列表优先于模型定义。

这些选项作用于会话请求，不作用于绕过会话事件的独立 SDK 调用，例如标题生成。

## 协议边界

请求改写支持提供对象 payload 的 Pi API，不设协议白名单。字段名称和结构取决于 SDK 适配器，不一定等同于最终 HTTP JSON。例如 Google 的生成选项位于 payload 的 `config` 中，覆盖整个 `config` 会替换其中已有的工具和系统指令，应谨慎使用。

核心字段 `model`、`messages`、`input`、`tools`、`stream`、`system`、`contents` 和 `systemInstruction` 受保护。

`maxTokens` 使用原生模型字段，须大于 0。模型定义和覆盖均未设置时，Chat Completions 与 Responses 会话移除 SDK 补出的输出上限，由服务端决定。其他协议保留原生输出预算。压缩和标题等独立请求使用自己的预算。

采样参数优先使用 SDK 原生 `samplingParams` 和 `samplingParamsByThinkingLevel`，各协议支持情况遵循 SDK。

超时和重试沿用 SDK 原生行为。旧 `timeoutMs`、`maxRetries` 扩展字段必须删除。候选模型查询使用独立的 8 秒超时，支持取消。

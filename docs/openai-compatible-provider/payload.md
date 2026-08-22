# 请求体处理

静态采样参数直接使用 Pi 的 `Model.samplingParams`。Pi 生成请求体后，扩展只处理 Responses API 的思考字段、提供方附加字段和待删除字段。

## 处理顺序

```text
1. Pi 合并 `model.samplingParams` 和单次请求的 `samplingParams`
2. Pi 传输层生成请求体并应用合并后的 `samplingParams`
3. 扩展转换 Responses API 使用的非 `openai` 思考预设
4. 扩展合并 `provider.extraBody`
5. 扩展依次应用 `provider.dropParams` 和 `model.dropParams`
6. 扩展恢复核心字段
7. 扩展调用后续注册的 `onPayload`
```

单次请求的 `samplingParams` 会覆盖模型配置中的同名字段。调用方的 `onPayload` 可以继续修改结果。如果 `onPayload` 返回 `undefined`，扩展使用第 6 步产生的请求体。核心字段保护只适用于扩展自己的 `extraBody` 和 `dropParams`，不会限制调用方后续的 `onPayload`。

## `samplingParams`

模型采样参数使用上游请求体字段名。扩展不会转换字段命名格式：

```jsonc
{
  "maxTokens": 8192,
  "samplingParams": {
    "temperature": 0.2,
    "top_p": 0.95,
    "top_k": 40,
    "min_p": 0.05,
    "repetition_penalty": 1.05
  }
}
```

`samplingParams` 会直接写入 Pi 的 `Model`。配置校验允许任意非空字段名，不单独限制 OpenAI 兼容采样字段。单次请求的 `samplingParams` 按字段覆盖模型配置。

最大输出令牌数应配置在模型顶层的 `maxTokens`。不要在 `samplingParams` 中设置 `max_tokens`、`max_completion_tokens` 或 `max_output_tokens`。这些字段会绕过 Pi 对上下文窗口、思考预算和 `compat.maxTokensField` 的处理。

也不要通过 `samplingParams` 覆盖 `model`、`messages`、`input`、`tools` 或 `stream` 等核心字段。

## `extraBody`

提供方可以为手写模型和自动发现的模型统一添加上游专用字段：

```jsonc
{
  "extraBody": {
    "custom_gateway_option": true
  }
}
```

只适用于单个模型的其他请求参数应放入 `samplingParams`。扩展不支持模型层的 `extraBody`。提供方的 `extraBody` 主要用于无法预先为动态模型逐个设置参数的场景，例如 `models: "auto"`。

`provider.extraBody` 不能包含以下核心字段：

```text
model, messages, input, tools, stream
```

如果配置包含这些字段，扩展会拒绝加载，而不是覆盖 Pi 生成的请求体。

## `dropParams`

`dropParams` 用于删除上游不接受的非核心字段：

```jsonc
{
  "dropParams": ["store", "parallel_tool_calls"]
}
```

扩展按以下顺序拼接两个列表：

```text
provider.dropParams + model.dropParams
```

删除发生在合并 `provider.extraBody` 之后。因此，`dropParams` 可以删除 Pi 或 `extraBody` 添加的非核心字段，但不能删除核心字段。

## 思考字段

Responses API 使用非 `openai` 预设时，扩展会先删除已有的思考字段，再按预设生成上游格式。详细映射见[思考预设](thinking.md)。

## 图片字段

Pi 会把图片输入写入 Chat Completions 的 `messages` 或 Responses API 的 `input`。这些结构属于核心字段，扩展会原样保留。

## 请求头

提供方和模型请求头不属于请求体。扩展在发送流式请求前解析并合并请求头。认证和调用方覆盖规则见[认证和敏感配置](authentication.md)。

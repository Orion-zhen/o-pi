# Payload 处理

静态采样参数直接使用 Pi 原生 `Model.samplingParams`；扩展只在 Pi 已生成请求后处理 Responses thinking 和必要的 provider 级 payload 扩展。

## 处理顺序

```text
1. Pi API 生成原始 payload
2. Pi 合并 model.samplingParams
3. Pi 合并请求期 samplingParams（同名字段覆盖 model）
4. 转换 Responses 的非 OpenAI thinking preset
5. 合并 provider.extraBody
6. 执行 provider/model dropParams
7. 恢复核心字段
8. 执行调用方后续 onPayload
```

后续 `onPayload` 可以继续变换结果；如果返回 `undefined`，使用扩展已经生成的 payload。

## `samplingParams`

模型采样参数使用上游请求体的原始字段名，不做 camelCase 转换：

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

`samplingParams` 会原样进入 Pi `Model`，因此 Pi 后续支持的任意 OpenAI-compatible sampling 参数无需修改扩展即可使用。请求期 `samplingParams` 按 key 覆盖模型值。

最大输出应使用模型顶层 `maxTokens`。不要在 `samplingParams` 中设置 `max_tokens`、`max_completion_tokens` 或 `max_output_tokens`，否则会绕过 Pi 的 context clamp、thinking budget 和 `compat.maxTokensField` 选择。

同样不要用 `samplingParams` 覆盖 `model`、`messages`、`input`、`tools` 或 `stream` 等核心字段。

## `extraBody`

provider 可以给静态和自动发现模型统一增加上游专用字段：

```jsonc
{
  "extraBody": {
    "custom_gateway_option": true
  }
}
```

模型级任意请求参数应使用 `samplingParams`，因此不再支持 `model.extraBody`。provider 级 `extraBody` 仅作为 `models: "auto"` 等动态目录无法预先设置模型参数时的逃生口。

`provider.extraBody` 不能包含：

```text
model, messages, input, tools, stream
```

配置中出现这些字段会报错，而不是覆盖 Pi 请求。

## `dropParams`

用于删除上游不接受的非核心字段：

```jsonc
{
  "dropParams": ["store", "parallel_tool_calls"]
}
```

provider 和 model 的列表会连接：

```text
provider.dropParams + model.dropParams
```

删除发生在 `provider.extraBody` 合并之后，因此可以删除 Pi 或扩展添加的非核心字段，但不能删除核心字段。

## Thinking payload

Responses 非 `openai` preset 会先清理已有 thinking 字段，再由 preset 生成新格式。详细映射见 [thinking.md](thinking.md)。

## 图片 payload

文件工具扩展不会把图片 base64 拼进文本。Pi 已生成的 Chat Completions `messages` 或 Responses `input` 图片结构会作为核心字段原样保留。

## Provider/model headers

header 不是 payload 字段，而是在 stream 边界解析和合并。认证与调用方覆盖规则见 [authentication.md](authentication.md)。

# Payload 处理

扩展在 Pi 已生成请求后，应用 model defaults、thinking preset 和 provider/model payload 扩展。

## 处理顺序

```text
1. Pi API 生成原始 payload
2. 用 model.defaults 补充缺失字段
3. 转换 Responses 的非 OpenAI thinking preset
4. 合并 provider/model extraBody
5. 执行 provider/model dropParams
6. 恢复核心字段
7. 执行调用方后续 onPayload
```

后续 `onPayload` 可以继续变换结果；如果返回 `undefined`，使用扩展已经生成的 payload。

## Sampling defaults

配置使用 camelCase，发送时转换为 OpenAI 风格字段：

| 配置字段 | payload 字段 |
| --- | --- |
| `temperature` | `temperature` |
| `topP` | `top_p` |
| `topK` | `top_k` |
| `minP` | `min_p` |
| `maxTokens` | Responses `max_output_tokens`；Completions 按 compat 选择 |
| `presencePenalty` | `presence_penalty` |
| `frequencyPenalty` | `frequency_penalty` |
| `repetitionPenalty` | `repetition_penalty` |
| `seed` | `seed` |
| `stop` | `stop` |

`defaults` 只在 payload 没有对应字段时补值：

```jsonc
{
  "defaults": {
    "temperature": 0.2,
    "topP": 0.95,
    "maxTokens": 8192
  }
}
```

`defaults.maxTokens` 是请求上限：如果 Pi 已生成更小的上限，保留更小值；不会抬高 Pi 的限制。

Completions 的最大 token 字段由 `compat.maxTokensField` 选择：

```jsonc
{ "compat": { "maxTokensField": "max_tokens" } }
```

未配置时使用保守默认值。

## `extraBody`

provider 和 model 都可以增加上游专用字段：

```jsonc
{
  "extraBody": {
    "provider": { "only": ["openai"] },
    "top_p": 0.9
  }
}
```

合并规则：

```text
provider.extraBody → model.extraBody
```

model 同名字段覆盖 provider 字段。`extraBody` 只能扩展非核心字段，不能包含：

```text
model, messages, input, tools, stream
```

配置中出现这些字段会报错，而不是静默覆盖 Pi 请求。

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

删除发生在 `extraBody` 合并之后，因此可以删除 Pi 或扩展添加的非核心字段，但不能删除核心字段。

## Thinking payload

Responses 非 `openai` preset 会先清理已有 thinking 字段，再由 preset 生成新格式。详细映射见 [thinking.md](thinking.md)。

## 图片 payload

文件工具扩展不会把图片 base64 拼进文本。Pi 已生成的 Chat Completions `messages` 或 Responses `input` 图片结构会作为核心字段原样保留。

## Provider/model headers

header 不是 payload 字段，而是在 stream 边界解析和合并。认证与调用方覆盖规则见 [authentication.md](authentication.md)。

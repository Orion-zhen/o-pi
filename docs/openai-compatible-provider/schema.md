# 配置字段

配置文件为 `~/.pi/agent/models.json`。原生字段由 SDK 处理，自定义字段与原生字段平铺。

## 原生 provider 和模型字段

使用 SDK 的 `name`、`baseUrl`、`apiKey`、`headers`、`api`、`compat`、`models` 和 `modelOverrides`。`models` 是对象数组，不接受字符串数组或 `"auto"`。

模型使用原生 `id`、`name`、`api`、`baseUrl`、`reasoning`、`thinkingLevelMap`、`input`、`inputLimits`、`cost`、`promptCache`、`contextWindow`、`maxTokens`、`samplingParams`、`samplingParamsByThinkingLevel`、`headers` 和 `compat`。

静态定义未指定上限时使用 SDK 默认值：`contextWindow=128000`、`maxTokens=16384`。扩展为发现模型采用相同默认值。没有元数据依据时，发现模型默认不支持推理，输入为文本，价格为零。

### inputLimits

由 SDK 校验和应用，包括 `maxRequestBytes`、`images.maxPerMessage`、`images.maxPerRequest` 和 `images.resize`。

图片在进入历史时由 SDK 统一处理，切换模型不会改写已有图片。省略 resize 字段时使用 SDK 默认值。配置校验和图片处理失败遵循 SDK，不由 provider 扩展补偿。

### 原生覆盖顺序

`models` 添加或替换同名模型。`modelOverrides` 在 SDK 组合完成后应用，未知 ID 被忽略。发现模型应通过 `modelOverrides` 修改元数据，避免完整静态定义覆盖发现的能力和等级映射。

`samplingParamsByThinkingLevel` 使用 Pi 等级名。SDK 先限制思考等级，再依次合并模型采样参数、有效等级采样参数和单次请求采样参数。

## provider 扩展字段

| 字段 | 行为 |
| --- | --- |
| `discoverModels` | `true` 时启用模型发现，默认不发现 |
| `modelsEndpoint` | 模型目录相对路径或绝对 URL，默认 `models`，要求启用发现 |
| `thinkingPreset` | Responses 非标准思考编码，或两种 API 的 `model-suffix` |
| `timeoutMs` | 流式请求默认超时，单次请求可覆盖 |
| `maxRetries` | 流式请求默认重试次数，非负整数，单次请求可覆盖 |
| `extraBody` | 请求体附加字段，不能覆盖核心字段 |
| `dropParams` | 删除请求体字段，不能删除核心字段 |

启用发现或请求改写的 provider 必须声明 `baseUrl` 和 OpenAI API 类型。仅设置 `defaultThinkingLevel` 或 `discoverModels: false` 不注册 provider，也不受这一约束。

## 模型扩展字段

以下字段可直接写在 `models` 条目或 `modelOverrides.<id>` 中：

| 字段 | 行为 |
| --- | --- |
| `thinkingPreset` | 覆盖 provider 预设 |
| `defaultThinkingLevel` | 选择模型时应用，恢复会话时不应用，不替换 provider |
| `dropParams` | 在 provider 列表之后删除请求体字段 |

模型级扩展选项按 provider 默认值、`models` 条目、`modelOverrides` 解析。`reasoning` 必须显式声明，`defaultThinkingLevel` 和 `thinkingLevelMap` 不再隐式启用推理。

完整预设和请求体顺序见 [思考编码](thinking.md) 和 [请求体处理](payload.md)。

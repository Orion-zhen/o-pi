# OpenAI 兼容提供方

该扩展把兼容 OpenAI Chat Completions API 或 Responses API 的服务注册为 Pi 提供方。基本配置只需指定 `baseUrl`、认证方式和模型。

## 快速开始

扩展读取以下配置文件：

```text
~/.pi/agent/models.jsonc
```

扩展不会读取或修改 Pi 自带的 `models.json`。`models.jsonc` 可能包含 API 密钥。建议限制文件权限：

```bash
chmod 600 ~/.pi/agent/models.jsonc
```

### 本地无认证服务

```jsonc
{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "apiKey": "EMPTY",
      "models": ["Qwen/Qwen3-Coder"]
    }
  }
}
```

### 使用环境变量认证

```jsonc
{
  "providers": {
    "gateway": {
      "baseUrl": "https://example.com/v1",
      "apiKey": "$EXAMPLE_API_KEY",
      "models": ["model-id"]
    }
  }
}
```

Pi 使用提供方 ID 和模型 ID 标识模型：

```text
gateway/model-id
```

使用 `/model` 选择模型。也可以离线检查模型目录：

```bash
pi --list-models gateway --offline
```

## 选择 API 类型

| `api` 值 | 适用服务 |
| --- | --- |
| `openai-completions` | 使用 `/chat/completions` 的服务 |
| `openai-responses` | 使用 `/responses` 的服务 |

提供方的 `api` 适用于该提供方的所有模型。模型可以覆盖此值：

```jsonc
{
  "providers": {
    "gateway": {
      "baseUrl": "https://example.com/v1",
      "api": "openai-completions",
      "models": [
        { "id": "reasoning-model", "api": "openai-responses" }
      ]
    }
  }
}
```

`api` 只接受 `openai-completions` 和 `openai-responses`。扩展会拒绝旧值 `chat` 和 `responses`。

## 提供方配置和模型配置

提供方配置包含一组模型共享的默认值：

- 端点和 API 类型
- API 密钥和请求头
- 兼容选项和思考预设
- 超时时间和重试次数
- 提供方的 `dropParams` 和 `extraBody`

模型配置包含模型元数据和覆盖值：

- `id`、显示名称和端点
- 推理能力、思考级别和级别映射
- `text` 和 `image` 输入能力
- 成本、上下文窗口和最大输出令牌数
- `samplingParams`、请求头、兼容选项和模型层的 `dropParams`

大多数字段按以下顺序解析：

```text
Pi 默认值
→ 提供方配置
→ 模型配置
```

`dropParams` 按提供方列表、模型列表的顺序拼接。`extraBody` 只能配置在提供方对象中，可以为手写模型和自动发现的模型统一添加请求体字段。

## 认证

`apiKey` 和 `headers` 的值支持以下写法：

| 写法 | 行为 |
| --- | --- |
| `"sk-..."` | 使用字面量 |
| `"$ENV"`、`"${ENV}"` | 替换为环境变量的值 |
| `"!command"` | 执行命令并读取标准输出 |
| `"EMPTY"` | `apiKey` 默认不发送 `Authorization` |
| `"$$"`、`"$!"` | 分别表示字面量 `$` 和 `!` |

`EMPTY` 只对 `apiKey` 有特殊含义。在 `headers` 中，`EMPTY` 是普通字面量。

省略提供方的 `apiKey` 或将其设为空字符串时，扩展读取以下环境变量：

```text
PI_MODELS_JSONC_<PROVIDER_ID>_API_KEY
```

例如，提供方 ID 为 `lab-server` 时，变量名为：

```text
PI_MODELS_JSONC_LAB_SERVER_API_KEY
```

Pi 在运行时提供的登录凭证可以覆盖配置中的密钥。`EMPTY` 表示默认不使用密钥，但 Pi 显式提供的登录凭证仍可用于当前请求。

扩展在发送请求前解析认证值和配置请求头，不会把明文认证信息写入模型目录缓存。完整规则见[认证和敏感配置](authentication.md)。

## 自动发现模型

`models` 支持以下形式：

```jsonc
// 手写模型
"models": ["model-a", { "id": "model-b", "name": "模型 B" }]

// 仅使用自动发现
"models": "auto"

// 省略 models 也表示仅使用自动发现
```

联网刷新会请求：

```text
GET <baseUrl>/models
```

即使配置了手写模型，联网刷新也会请求模型目录端点，并用远端数据补充模型目录。`modelsEndpoint` 可以指定相对路径或完整 URL。端点可以返回数组、`{ "data": [...] }` 或 `{ "models": [...] }`。

扩展保留手写模型的顺序和字段。远端元数据只补充缺失的名称、上下文窗口、最大输出和图片输入能力。远端独有的模型追加到目录末尾。

Pi 的 `ModelsStore` 会保存刷新后的模型目录。离线模式只使用手写模型和来源匹配的缓存。完整流程见[自动发现](discovery.md)。

## 推理能力和思考级别

`thinkingPreset` 指定如何把 Pi 思考级别编码为上游字段。支持以下预设：

- `none`
- `openai`
- `openrouter`
- `deepseek`
- `together`
- `zai`
- `qwen`
- `qwen-chat-template`
- `chat-template-enabled`
- `chat-template-effort`
- `string-thinking`
- `ant-ling`

`defaultThinkingLevel` 会在模型选择事件触发时设置，但恢复会话时除外。因此，恢复会话不会覆盖已恢复的思考级别。`thinkingLevelMap` 可以把 Pi 的 `high`、`xhigh` 等级别映射为上游值。

配置 `defaultThinkingLevel` 或 `thinkingLevelMap` 后，扩展会将模型的推理能力推导为 `true`。`reasoning: false` 不能与这两个字段同时使用。

全部预设及 Responses API 的处理规则见[思考预设](thinking.md)。

## 修改请求体

扩展按以下顺序处理请求体：

```text
合并模型和单次请求的 samplingParams
→ Pi 生成请求体
→ 转换 Responses API 的思考字段
→ 合并提供方 extraBody
→ 删除 provider/model dropParams
→ 恢复核心字段
```

模型的 `samplingParams` 直接写入 Pi 的 `Model`，其中应使用 `top_p`、`top_k` 等上游字段名。单次请求的同名参数优先。最大输出令牌数应使用模型顶层的 `maxTokens`。不要把令牌上限或核心请求字段放入 `samplingParams`。

只适用于单个模型的其他请求参数应放入 `samplingParams`。提供方的 `extraBody` 可以为所有模型统一添加字段，但不能覆盖以下核心字段：

```text
model, messages, input, tools, stream
```

`dropParams` 也不能删除这些核心字段。详细规则见[请求体处理](payload.md)。

## 安全和持久化

- 使用环境变量引用或命令获取 API 密钥，可以避免把密钥直接写入配置。
- 配置文件权限过宽时，扩展会显示警告。
- 认证检查不会执行命令。扩展在解析凭证或发送请求时执行命令，并在进程内缓存结果。
- 模型目录缓存包含模型元数据和配置来源哈希，不包含 API 密钥或认证请求头。
- 模型目录端点返回非 2xx 状态时，错误包含提供方和 HTTP 状态，并最多截取响应正文的前 500 个字符。扩展不会把请求中的 `Authorization` 写入错误。

## 常见问题

### 模型没有显示

1. 确认 `models.jsonc` 是合法的 JSONC。
2. 确认提供方包含非空 `baseUrl`。
3. 确认每个模型都有非空且不重复的 `id`。
4. 确认 `apiKey`、环境变量或自定义认证请求头可用。
5. 在联网模式下打开 `/model`，触发模型目录刷新。
6. 运行 `pi --list-models <provider> --offline`，检查手写模型和缓存。

### 模型发现失败

确认模型目录端点返回数组、`data` 数组或 `models` 数组。然后检查 HTTP 状态、认证配置和 `modelsEndpoint`。自动发现使用独立的 30 秒超时。提供方的 `timeoutMs` 控制模型流式请求，不控制模型目录请求。

### 上游拒绝请求

先确认 `api` 类型。然后检查 `compat`、`thinkingPreset`、`samplingParams`、`dropParams` 和提供方的 `extraBody`。不要通过请求体扩展覆盖核心字段。

## 深入阅读

- [配置加载和校验](configuration.md)
- [提供方和模型字段](schema.md)
- [认证和请求头](authentication.md)
- [Pi 兼容选项](compatibility.md)
- [思考预设](thinking.md)
- [请求体处理](payload.md)
- [自动发现和 `ModelsStore`](discovery.md)
- [配置示例](examples.md)
- [故障排查](troubleshooting.md)

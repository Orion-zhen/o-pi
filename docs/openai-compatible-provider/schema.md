# Provider 和 Model schema

## Provider

```jsonc
{
  "providers": {
    "provider-id": {
      "name": "Display name",
      "baseUrl": "https://example.com/v1",
      "apiKey": "$API_KEY",
      "api": "openai-completions",
      "headers": {},
      "compat": {},
      "models": [],
      "thinkingPreset": "none",
      "modelsEndpoint": "models",
      "timeoutMs": 600000,
      "maxRetries": 0,
      "dropParams": [],
      "extraBody": {}
    }
  }
}
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `name` | provider id | `/model` 和 `/login` 中的显示名。 |
| `baseUrl` | 必填 | provider endpoint。 |
| `apiKey` | `$PI_MODELS_JSONC_<PROVIDER>_API_KEY` | API key 配置值；`EMPTY` 表示默认无认证。 |
| `api` | `openai-completions` | `openai-completions` 或 `openai-responses`。 |
| `headers` | `{}` | provider 请求和 models endpoint header。 |
| `compat` | 保守默认值 | Pi 原生 compat 对象。 |
| `models` | 自动发现 | 字符串、模型对象数组或 `"auto"`。 |
| `thinkingPreset` | `none` | provider 默认 thinking 编码。 |
| `modelsEndpoint` | `models` | 相对 `baseUrl` 的路径或完整 URL。 |
| `timeoutMs` | Pi 默认 | 模型请求 stream 的 timeout。 |
| `maxRetries` | Pi/API 默认 | 模型请求重试次数。 |
| `dropParams` | `[]` | 从最终 payload 删除的非核心字段。 |
| `extraBody` | `{}` | 合入最终 payload 的非核心字段。 |

## Model

model 可以是字符串：

```jsonc
"models": ["model-id"]
```

也可以是完整对象：

```jsonc
{
  "id": "model-id",
  "name": "Display name",
  "api": "openai-completions",
  "baseUrl": "https://model.example.com/v1",
  "reasoning": true,
  "thinkingLevelMap": { "off": "none", "xhigh": "max" },
  "input": ["text", "image"],
  "cost": {
    "input": 0,
    "output": 0,
    "cacheRead": 0,
    "cacheWrite": 0
  },
  "contextWindow": 128000,
  "maxTokens": 16384,
  "headers": {},
  "compat": {},
  "thinkingPreset": "openai",
  "defaultThinkingLevel": "high",
  "defaults": { "temperature": 0.2, "topP": 0.95 },
  "dropParams": [],
  "extraBody": {}
}
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `id` | 必填 | Pi model id，同时作为请求中的 API model。 |
| `name` | `id` | 显示名。 |
| `api` | provider `api` | 单独选择 Completions 或 Responses。 |
| `baseUrl` | provider `baseUrl` | 模型级 endpoint。 |
| `reasoning` | 自动推导 | 是否支持 thinking level。 |
| `thinkingLevelMap` | 未设置 | Pi level 到上游值的映射；值为 `null` 表示隐藏该 level。 |
| `input` | `["text"]` | 支持 `text` 和可选的 `image`。 |
| `cost` | 全零 | 每百万 token 成本，可包含 `tiers`。 |
| `contextWindow` | `128000` | 上下文窗口。 |
| `maxTokens` | `16384` | 最大输出 token。 |
| `headers` | `{}` | 模型级 header；运行时解析。 |
| `compat` | provider compat | 模型级 compat，优先级最高。 |
| `thinkingPreset` | provider preset | 模型级 thinking 编码。 |
| `defaultThinkingLevel` | 未设置 | 用户主动选择该模型时的默认 level。 |
| `defaults` | `{}` | 请求采样默认值。 |
| `dropParams` | `[]` | 追加到 provider 列表。 |
| `extraBody` | `{}` | 覆盖 provider 同名扩展字段。 |

## `cost.tiers`

`cost` 可以为不同输入 token 阶梯配置费率：

```jsonc
{
  "input": 1,
  "output": 2,
  "cacheRead": 0.1,
  "cacheWrite": 0.2,
  "tiers": [
    {
      "inputTokensAbove": 100000,
      "input": 2,
      "output": 4,
      "cacheRead": 0.2,
      "cacheWrite": 0.4
    }
  ]
}
```

## 相关字段

- compat 字段和 API-specific 过滤见 [compatibility.md](compatibility.md)。
- thinking 字段见 [thinking.md](thinking.md)。
- sampling、`dropParams` 和 `extraBody` 见 [payload.md](payload.md)。
- 完整可用示例见 [examples.md](examples.md)。

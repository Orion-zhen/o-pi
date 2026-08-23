# 提供方和模型配置模式

## 提供方

以下示例列出所有提供方字段：

```jsonc
{
  "providers": {
    "provider-id": {
      "name": "显示名称",
      "baseUrl": "https://example.com/v1",
      "apiKey": "$API_KEY",
      "api": "openai-completions",
      "headers": {},
      "compat": {},
      "models": "auto",
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
| `name` | 提供方 ID | `/model` 和 `/login` 中显示的名称 |
| `baseUrl` | 必填 | 提供方的 API 端点 |
| `apiKey` | `$PI_MODELS_JSONC_<PROVIDER_ID>_API_KEY` | API 密钥配置值。`EMPTY` 表示默认不认证 |
| `api` | `openai-completions` | `openai-completions` 或 `openai-responses` |
| `headers` | `{}` | 模型请求和模型目录请求使用的提供方请求头 |
| `compat` | 保守默认值 | 传给 Pi 传输层的兼容选项 |
| `models` | `"auto"` | `"auto"`，或由非空字符串和模型对象组成的非空数组 |
| `thinkingPreset` | `none` | 提供方默认的思考字段编码方式 |
| `modelsEndpoint` | `models` | 相对于 `baseUrl` 的路径或完整 URL |
| `timeoutMs` | Pi 默认值 | 模型流式请求的超时时间，单位为毫秒 |
| `maxRetries` | 未设置 | 模型请求的重试次数。未设置时由 Pi 处理 |
| `dropParams` | `[]` | 从最终请求体中删除的非核心字段 |
| `extraBody` | `{}` | 为该提供方的所有模型添加的非核心字段，主要用于自动发现的模型 |

使用自动发现时，模型目录端点必须返回 `{ "data": [...] }`。每个条目必须是包含非空且不重复 `id` 的对象。扩展只读取 `context_length` 和 `architecture.input_modalities`，其他远端字段不会进入模型配置。

## 模型

模型可以写成字符串：

```jsonc
"models": ["model-id"]
```

也可以写成对象：

```jsonc
{
  "id": "model-id",
  "name": "显示名称",
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
  "samplingParams": { "temperature": 0.2, "top_p": 0.95 },
  "dropParams": []
}
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `id` | 必填 | Pi 模型 ID，也是发送给上游的模型 ID |
| `name` | `id` | 模型显示名称 |
| `api` | 提供方的 `api` | 为该模型选择 Completions 或 Responses |
| `baseUrl` | 提供方的 `baseUrl` | 该模型使用的 API 端点 |
| `reasoning` | 自动推导 | 模型是否支持推理和思考级别 |
| `thinkingLevelMap` | 未设置 | Pi 思考级别到上游值的映射。值为 `null` 时隐藏对应级别 |
| `input` | `["text"]` | 输入类型列表，可包含 `text` 和 `image` |
| `cost` | 各项为 `0` | 每百万个令牌的成本。可以包含 `tiers` |
| `contextWindow` | `128000` | 上下文窗口大小 |
| `maxTokens` | `16384` | 最大输出令牌数 |
| `headers` | `{}` | 发送模型请求前解析的模型请求头 |
| `compat` | 提供方的兼容选项 | 模型的兼容选项，按顶层字段覆盖提供方配置。对象字段整体覆盖 |
| `thinkingPreset` | 提供方的预设 | 模型的思考字段编码方式 |
| `defaultThinkingLevel` | 未设置 | 模型选择事件触发时设置的默认思考级别。恢复会话时除外 |
| `samplingParams` | `{}` | Pi 模型的采样参数，使用上游请求体字段名 |
| `dropParams` | `[]` | 追加到提供方 `dropParams` 的字段列表 |

## `cost.tiers`

当总输入令牌数超过指定阈值时，`cost.tiers` 可以为整次请求应用另一组费率：

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

基础费率和每个阶梯必须包含 `input`、`output`、`cacheRead` 和 `cacheWrite`。如果多个阶梯匹配，Pi 使用阈值最高的阶梯。

## 相关文档

- `compat` 的 Pi 类型和向前兼容策略见[Pi 兼容选项](compatibility.md)。
- 思考字段见[思考预设](thinking.md)。
- `samplingParams`、`dropParams` 和 `extraBody` 见[请求体处理](payload.md)。
- 完整配置见[配置示例](examples.md)。

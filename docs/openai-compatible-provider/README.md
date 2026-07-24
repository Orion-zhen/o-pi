# OpenAI-compatible provider

本扩展把任意兼容 OpenAI Chat Completions 或 Responses API 的服务注册为原生 Pi provider。普通配置只需要一个 `baseUrl`、一个认证方式和一个模型。

## 快速开始

配置文件是：

```text
~/.pi/agent/models.jsonc
```

扩展只读取这个私有 JSONC 文件，不修改 Pi 原生 `models.json`。配置可能包含 API key，建议限制权限：

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

provider id 和 model id 组成 Pi selector：

```text
gateway/model-id
```

可用 `/model` 选择模型，也可以验证离线目录：

```bash
pi --list-models gateway --offline
```

## 选择 API 类型

| 配置 | 适用服务 |
| --- | --- |
| `openai-completions` | `/chat/completions` 风格服务 |
| `openai-responses` | `/responses` 风格服务 |

provider 的 `api` 是默认值，单个 model 可以覆盖它：

```jsonc
{
  "providers": {
    "gateway": {
      "baseUrl": "https://example.com/v1",
      "api": "openai-responses",
      "models": [
        { "id": "reasoning-model", "api": "openai-responses" }
      ]
    }
  }
}
```

只使用 `openai-completions` 和 `openai-responses`。旧的 `chat`、`responses` 简写会被拒绝。

## Provider 和 Model

provider 保存一组模型共享的默认值：

- endpoint 和 API 类型；
- API key、header；
- compat 和 thinking preset；
- timeout、重试次数；
- payload 的 `dropParams` 和 `extraBody`。

model 保存自身的元数据和覆盖值：

- `id`、显示名和 endpoint；
- reasoning、thinking level 和 level map；
- text/image 输入能力；
- 成本、上下文窗口和最大输出；
- sampling defaults、header、compat 和 payload 扩展。

通常的继承关系是：

```text
Pi 默认值
→ provider 值
→ model 值
```

`dropParams` 是追加，`extraBody` 是浅层合并且 model 同名字段覆盖 provider 字段。

## 认证

`apiKey` 和 `headers` 支持以下写法：

| 写法 | 行为 |
| --- | --- |
| `"sk-..."` | 字面量 |
| `"$ENV"`、`"${ENV}"` | 环境变量插值 |
| `"!command"` | 执行命令获取 stdout |
| `"EMPTY"` | 默认不发送 Authorization |
| `"$$"`、`"$!"` | 字面量 `$` 或 `!` |

省略 provider 的 `apiKey` 时，默认环境变量为：

```text
PI_MODELS_JSONC_<PROVIDER_ID>_API_KEY
```

例如 provider id 为 `lab-server` 时使用：

```text
PI_MODELS_JSONC_LAB_SERVER_API_KEY
```

调用方传入的认证 credential 可以覆盖配置中的 key。`EMPTY` 表示默认 keyless；显式登录 credential 仍可以提供运行时 key。

认证值和配置 header 会在请求边界解析，不会作为明文写入发现目录。完整规则见 [认证和敏感配置](authentication.md)。

## 自动发现模型

`models` 有三种常用形式：

```jsonc
// 手写模型
"models": ["model-a", { "id": "model-b", "name": "Model B" }]

// 自动发现
"models": "auto"

// 省略时也使用默认 models endpoint
```

自动发现默认请求：

```text
GET <baseUrl>/models
```

`modelsEndpoint` 可以改为相对路径或完整 URL。支持返回数组、`{ "data": [...] }` 或 `{ "models": [...] }`。

手写模型优先保留，远端目录补齐缺失的名称、上下文、最大输出和 image 能力；远端独有模型追加到末尾。Pi `ModelsStore` 会保存已发现目录，`--offline` 只使用手写模型和已存目录。

完整流程见 [自动发现](discovery.md)。

## Thinking

通过 `thinkingPreset` 告诉扩展如何把 Pi thinking level 编码给上游服务。常见 preset 包括：

- `openai`
- `openrouter`
- `deepseek`
- `qwen`
- `chat-template-enabled`
- `chat-template-effort`

`defaultThinkingLevel` 只在用户主动选择模型时设置；恢复 session 时不会覆盖已恢复的 level。`thinkingLevelMap` 可以把 Pi 的 `high`、`xhigh` 等 level 映射为上游值。

如果配置了 `defaultThinkingLevel` 或 `thinkingLevelMap`，model 会推导为支持 reasoning；显式 `reasoning: false` 与这两项同时出现会报错。

完整 preset 和 Responses API 行为见 [Thinking preset](thinking.md)。

## Payload 修改

请求 payload 的处理顺序是：

```text
Pi 生成 payload
→ 补充 model defaults
→ 转换 Responses thinking
→ 合并 extraBody
→ 删除 dropParams
→ 恢复核心字段
```

`defaults` 只补充缺失字段；`maxTokens` 是上限，不会抬高 Pi 已生成的值。字段使用 camelCase 配置，发送时转换为 OpenAI 风格字段，例如 `topP` → `top_p`、Responses 的 `maxTokens` → `max_output_tokens`。

`extraBody` 不能覆盖以下核心字段：

```text
model, messages, input, tools, stream
```

`dropParams` 也不能删除这些核心字段。详细映射见 [Payload 处理](payload.md)。

## 安全和持久化

- API key 可以使用环境变量或 command，避免直接写入配置。
- 配置权限过宽时会显示 warning。
- auth check 不执行 command 配置；真正请求时才解析并缓存 command stdout。
- 自动发现缓存包含模型元数据、endpoint/API/compat source hash，不包含 API key 或认证 header。
- 自动发现错误会包含 provider、HTTP 状态和有限的响应片段，但不会泄露 Authorization。

## 常见问题

### 模型没有显示

1. 确认 `models.jsonc` 是合法 JSONC。
2. 确认 provider 有 `baseUrl`。
3. 确认每个 model 有非空且不重复的 `id`。
4. 使用 `EMPTY`、环境变量或可用的配置 header。
5. 在线打开 `/model` 触发目录刷新。
6. 使用 `pi --list-models <provider> --offline` 检查手写模型和缓存。

### endpoint 发现失败

确认 endpoint 返回数组、`data` 数组或 `models` 数组，并检查 HTTP 状态、认证和 `modelsEndpoint`。自动发现使用独立的 30 秒请求 timeout；provider 的 `timeoutMs` 主要控制模型请求 stream。

### 上游拒绝请求

先确认 `api` 类型，再检查 `compat`、`thinkingPreset`、`dropParams` 和 `extraBody`。不要用 payload 扩展覆盖核心字段。

## 深入阅读

- [配置加载和错误](configuration.md)
- [Provider/Model 字段](schema.md)
- [认证和 header](authentication.md)
- [Pi compat](compatibility.md)
- [Thinking preset](thinking.md)
- [Payload 处理](payload.md)
- [自动发现和 ModelsStore](discovery.md)
- [可复制示例](examples.md)
- [故障排查](troubleshooting.md)

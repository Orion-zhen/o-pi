# OpenAI-compatible provider

扩展从以下私有配置注册原生 Pi provider：

```text
~/.pi/agent/models.jsonc
```

配置字段尽量直接复用 Pi `models.json`、`Provider` 和 `Model` 的 camelCase 字段。只有自动发现、预设、默认 thinking level 和 payload 修改使用扩展字段。

配置可能包含 API key：

```bash
chmod 600 ~/.pi/agent/models.jsonc
```

自动发现结果由 Pi `ModelsStore` 持久化到 `~/.pi/agent/models-store.json`。其中包含模型元数据、`baseUrl` 和 endpoint/API/compat 来源哈希，不包含 API key 或配置的认证 header。

## 完整结构

```jsonc
{
  "providers": {
    "<provider-id>": {
      // Pi Provider 字段
      "name": "显示名",
      "baseUrl": "https://example.com/v1",
      "apiKey": "$EXAMPLE_API_KEY",
      "api": "openai-completions",
      "headers": {},
      "compat": {},
      "models": [
        "model-id",
        {
          // Pi Model 字段
          "id": "other-model-id",
          "name": "Other Model",
          "api": "openai-completions",
          "baseUrl": "https://model.example.com/v1",
          "reasoning": true,
          "thinkingLevelMap": {
            "off": "none",
            "xhigh": "max"
          },
          "input": ["text"],
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

          // 扩展字段
          "thinkingPreset": "openai",
          "defaultThinkingLevel": "high",
          "defaults": {
            "temperature": 0.2,
            "topP": 0.95,
            "maxTokens": 8192
          },
          "dropParams": [],
          "extraBody": {}
        }
      ],

      // 扩展字段
      "compatPreset": "openai-compatible",
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

`providers` 是唯一根字段。provider key 就是 Pi provider id，例如 `lab-server/model-id` 中的 `lab-server`。同名注册会替换 Pi 内置 provider。

## Provider 字段

### 与 Pi 对齐的字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `name` | provider id | `/model` 和 `/login` 中的显示名。 |
| `baseUrl` | 必填 | Provider endpoint，一般以 `/v1` 结尾。 |
| `apiKey` | `$PI_MODELS_JSONC_<PROVIDER>_API_KEY` | API key 配置值。`EMPTY` 表示无认证。 |
| `api` | `openai-completions` | `openai-completions` 或 `openai-responses`。 |
| `headers` | `{}` | Provider 认证/请求 header；按配置值语义逐请求解析。 |
| `compat` | `{}` | Pi 原生 compat 对象，覆盖 `compatPreset` 和 `thinkingPreset` 展开值。 |
| `models` | `"auto"` | Pi 原生对象数组；扩展另支持 `"auto"` 和字符串 `{ "id": "..." }` 快捷形式。 |

`headers` 沿用 Pi 配置字段名，但完整 Provider 会在 `ApiKeyAuth` 边界解析它，避免把环境变量或命令原文放进公开 Provider 元数据。

省略 `apiKey` 时，provider `lab-server` 默认读取：

```text
PI_MODELS_JSONC_LAB_SERVER_API_KEY
```

`apiKey` 和 `headers` 支持 Pi 配置值语义：

| 写法 | 含义 |
| --- | --- |
| `"sk-..."` | 字面量。 |
| `"$ENV"`、`"${ENV}"` | 环境变量插值。 |
| `"!command"` | 执行命令并缓存 stdout。认证可用性检查不会执行命令。 |
| `"EMPTY"` | keyless provider，不发送 Authorization。 |
| `"$$"`、`"$!"` | 字面量 `$` 和 `!`。 |

### 扩展字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `compatPreset` | `openai-compatible` | 高层兼容预设；不会占用 Pi 原生 `compat` 字段。 |
| `thinkingPreset` | `none` | Provider 默认 thinking payload 编码。 |
| `modelsEndpoint` | `models` | 相对 `baseUrl` 的模型目录路径或完整 URL。 |
| `timeoutMs` | Pi 默认 | Provider 请求 timeout。 |
| `maxRetries` | Pi/API 默认 | Provider 请求重试次数。 |
| `dropParams` | `[]` | 从最终 payload 删除字段。 |
| `extraBody` | `{}` | 合入最终 payload；不能覆盖核心字段。 |

采样默认值不允许放在 provider 上，应放到具体模型的 `defaults`。

## Model 字段

字符串模型：

```jsonc
"models": ["openai/gpt-4.1"]
```

等价于：

```jsonc
"models": [{ "id": "openai/gpt-4.1" }]
```

### 与 Pi 对齐的字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `id` | 必填 | Pi model id，同时作为请求中的 API model。 |
| `name` | `id` | 显示名。 |
| `api` | provider `api` | 可按模型选择 `openai-completions` 或 `openai-responses`。 |
| `baseUrl` | provider `baseUrl` | 模型级 endpoint。 |
| `reasoning` | 见下文 | 是否支持 thinking level。 |
| `thinkingLevelMap` | Pi 默认 | Pi thinking level 到上游值的映射；`null` 表示不支持。 |
| `input` | `["text"]` | `["text"]` 或 `["text", "image"]`。 |
| `cost` | 全零 | 每百万 token 成本；支持 Pi 原生 `tiers`。 |
| `contextWindow` | `128000` | 上下文窗口。 |
| `maxTokens` | `16384` | 最大输出 token。 |
| `headers` | `{}` | 模型请求 header；运行时解析，调用方 header 优先。 |
| `compat` | `{}` | 模型级 Pi 原生 compat，优先级最高。 |

模型 `headers` 同样在 stream 边界解析，配置 header 先应用，调用方 header 后覆盖；原文不会进入持久化模型元数据。

`reasoning` 遵循 Pi 原生语义：

- 省略时，只要设置了 `defaultThinkingLevel` 或 `thinkingLevelMap` 就推导为 `true`，否则为 `false`。
- 显式 `false` 不能同时配置 `defaultThinkingLevel`/`thinkingLevelMap`，避免矛盾能力声明。
- `thinkingLevelMap` 直接传给 Pi；`null` 会隐藏对应 level。
- `xhigh`/`max` 需要显式 map 才会出现在可选 level 中。

### 扩展字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `thinkingPreset` | provider 值 | 覆盖 provider thinking payload 编码。 |
| `defaultThinkingLevel` | 未设置 | 用户主动选择模型时设置一次，不覆盖 session 恢复值。 |
| `defaults` | `{}` | 请求采样默认值；一般只补缺失字段，`maxTokens` 作为请求上限且不会抬高 Pi 已裁剪的值。 |
| `dropParams` | `[]` | 追加到 provider `dropParams`。 |
| `extraBody` | `{}` | 覆盖 provider `extraBody` 同名字段。 |

## Compat

`compatPreset` 先展开，随后依次合并：

1. `thinkingPreset` 对应的 Pi compat。
2. provider `compat`。
3. model `compat`。

与 Pi 原生 composer 一致，`openRouterRouting`、`vercelGatewayRouting`、`chatTemplateKwargs` 逐键合并，模型只覆盖自己提供的子字段。

运行时保留 thinking 转换所需 compat；注册为 `openai-responses` 的 Pi Model 只携带 Responses API 支持的 compat 字段，避免把 Chat-only 字段泄漏到原生模型元数据。

可用 `compatPreset`：

| 值 | 用途 |
| --- | --- |
| `openai` | 完整 OpenAI 行为。 |
| `openai-compatible` | 第三方网关安全默认值：关闭 store、developer role、默认 reasoning effort。 |
| `local` | vLLM/SGLang/Ollama/LM Studio；使用 `max_tokens` 并允许 streaming usage。 |
| `qwen` | local 基础上允许 Qwen 常用采样字段。 |
| `deepseek` | local 基础上允许 DeepSeek 常用采样字段。 |
| `strict` | 保留 developer role/reasoning effort，用于完整实现或调试。 |

`compat` 使用 Pi 原生 camelCase 字段，例如：

```jsonc
{
  "compatPreset": "openai-compatible",
  "compat": {
    "supportsDeveloperRole": true,
    "maxTokensField": "max_tokens"
  }
}
```

## Thinking preset

| preset | 开启时主要字段 | 关闭时 |
| --- | --- | --- |
| `none` | 不发送控制字段 | 不发送 |
| `openai` | Chat `reasoning_effort`；Responses `reasoning.effort` | Responses 默认 `none` |
| `openrouter` | `reasoning: { effort }` | effort `none` |
| `deepseek` | `thinking: { type: "enabled" }` | `disabled` |
| `together` | `reasoning: { enabled: true }` | `false` |
| `zai` | `thinking: { type: "enabled", clear_thinking: false }` | `disabled` |
| `qwen` | `enable_thinking: true` | `false` |
| `qwen-chat-template` | `chat_template_kwargs.enable_thinking` + `preserve_thinking` | `false` |
| `chat-template-enabled` | `chat_template_kwargs.enable_thinking` | `false` |
| `chat-template-effort` | `chat_template_kwargs.reasoning_effort` | 默认 `none`/省略 |
| `string-thinking` | `thinking: "<level>"` | `"none"` |
| `ant-ling` | 有显式 map 时发送 `reasoning.effort` | 不发送 |

示例：

```jsonc
{
  "id": "reasoning-model",
  "reasoning": true,
  "thinkingPreset": "openrouter",
  "defaultThinkingLevel": "xhigh",
  "thinkingLevelMap": {
    "off": "none",
    "minimal": null,
    "xhigh": "max"
  }
}
```

## Defaults 和 payload 扩展

`defaults` 使用 camelCase 配置，扩展转换成 OpenAI payload：

| 配置字段 | payload 字段 |
| --- | --- |
| `temperature` | `temperature` |
| `topP` | `top_p` |
| `topK` | `top_k`（仅 `local`/`qwen`/`deepseek`） |
| `minP` | `min_p`（同上） |
| `maxTokens` | Responses `max_output_tokens`；Chat 按 compat 选择 token 字段；与 Pi 已生成上限取较小值 |
| `presencePenalty` | `presence_penalty` |
| `frequencyPenalty` | `frequency_penalty` |
| `repetitionPenalty` | `repetition_penalty`（仅 local 类 preset） |
| `seed` | `seed` |
| `stop` | `stop` |

payload 处理顺序：

1. Pi API 生成原始 payload。
2. 用 model `defaults` 补充缺失字段；`defaults.maxTokens` 与 Pi 生成值取较小值。
3. Responses 非 `openai` thinking preset 转换。
4. 合并 provider/model `extraBody`。
5. 执行 provider/model `dropParams`。
6. 恢复 `model`、`messages`、`input`、`tools`、`stream` 核心字段。

`extraBody` 不能包含这些核心字段。

## 自动发现

`models` 省略或为 `"auto"` 时，只使用 Pi 存储/发现目录。数组会立即注册手写模型；刷新后，同 ID 模型以 endpoint 元数据为基底、手写字段覆盖，因此远端会补齐手写模型的缺失字段。远端独有模型按 endpoint 顺序追加。缓存恢复或在线刷新完成后，provider 会重新发布目录，使当前同 ID 模型同步采用新元数据。

默认请求：

```text
GET <baseUrl>/models
Accept: application/json
```

`modelsEndpoint` 可覆盖路径。支持响应：

```jsonc
{ "data": [{ "id": "model-id" }] }
```

也支持顶层数组或 `{ "models": [...] }`。会读取常见名称、context、最大输出和 image modality 元数据。

Pi `/model` selector 会先显示 `ModelsStore` 中的目录，再通过官方 `ModelRuntime.refresh()` 后台刷新。`PI_OFFLINE=1`/`--offline` 只使用手写模型和已存目录。`print`、`json`、`--list-models` 不由扩展主动联网。

## 示例

### 本地 vLLM

```jsonc
{
  "providers": {
    "vllm": {
      "name": "Local vLLM",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "apiKey": "EMPTY",
      "api": "openai-completions",
      "compatPreset": "local",
      "models": ["Qwen/Qwen3-Coder-480B-A35B-Instruct"]
    }
  }
}
```

### OpenRouter

```jsonc
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "$OPENROUTER_API_KEY",
      "api": "openai-completions",
      "compatPreset": "openai-compatible",
      "thinkingPreset": "openrouter",
      "headers": {
        "HTTP-Referer": "https://example.local"
      },
      "models": [
        {
          "id": "deepseek/deepseek-r1",
          "name": "DeepSeek R1",
          "reasoning": true,
          "contextWindow": 131072,
          "maxTokens": 32768,
          "defaultThinkingLevel": "high",
          "defaults": {
            "temperature": 0.2,
            "topP": 0.95,
            "maxTokens": 8192
          }
        }
      ],
      "dropParams": ["store"]
    }
  }
}
```

## 验证

```bash
pi --list-models lab-server --offline
```

若模型未出现：

1. 确认 `models.jsonc` 可解析，字段使用 camelCase。
2. 确认 `apiKey` 可解析；keyless 服务使用 `EMPTY`。
3. 确认模型对象包含 `id` 且不重复。
4. 在线打开 `/model` 检查目录刷新提示和 `modelsEndpoint`。

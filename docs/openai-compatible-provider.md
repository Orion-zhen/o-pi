# OpenAI-compatible provider

本扩展从私有配置文件注册自定义 OpenAI-compatible provider：

```text
~/.pi/agent/models.jsonc
```

文件可能包含 API key，不要提交到 git。建议：

```bash
chmod 600 ~/.pi/agent/models.jsonc
```

## 完整结构

```jsonc
{
  "providers": {
    "<provider-id>": {
      "display_name": "显示名",
      "base_url": "https://example.com/v1",
      "api_key": "$EXAMPLE_API_KEY",
      "api": "chat",
      "compat": "openai_compatible",
      "models": [
        "model-id",
        {
          "model": "other-model-id",
          "display_name": "Other Model",
          "context_window": 128000,
          "max_tokens": 16384,
          "reasoning_effort": "off",
          "input": ["text"],
          "defaults": {
            "temperature": 0.2,
            "top_p": 0.95,
            "max_tokens": 8192
          },
          "advanced": {
            "compat": {},
            "drop_params": [],
            "extra_body": {}
          }
        }
      ],
      "advanced": {
        "headers": {},
        "timeout_ms": 600000,
        "max_retries": 0,
        "drop_params": [],
        "extra_body": {}
      }
    }
  }
}
```

只有 `providers` 是根字段。provider key 就是 Pi 里的 provider id，例如 `/model` 中的 `lab-server/gemma4-pro` 里的 `lab-server`。

## Provider 字段

| 字段 | 必填 | 默认值 | 可取值 | 说明 |
| --- | --- | --- | --- | --- |
| `display_name` | 否 | provider id | 非空字符串 | `/model` 中显示的 provider 名称。 |
| `base_url` | 是 | 无 | 非空 URL 字符串 | OpenAI-compatible endpoint，一般以 `/v1` 结尾。会传给 `pi.registerProvider(...).baseUrl`。 |
| `api_key` | 否 | `$PI_MODELS_JSONC_<PROVIDER>_API_KEY` | 字符串 | API key 配置值，会传给 Pi 的 provider auth 解析逻辑。 |
| `api` | 否 | `chat` | `chat`、`responses` | `chat` 注册为 `openai-completions`；`responses` 注册为 `openai-responses`。 |
| `compat` | 否 | `openai_compatible` | `openai`、`openai_compatible`、`local`、`qwen`、`deepseek`、`strict` | 高层兼容 preset，展开后传给每个模型的 `compat`。 |
| `models` | 是 | 无 | 非空数组 | 每项可以是字符串模型 id，也可以是模型对象。provider 内模型 id 不能重复。 |
| `advanced` | 否 | `{}` | 对象 | provider 级高级配置。 |

`api_key` 和 `advanced.headers` 的字符串值由 Pi 解析：

| 写法 | 含义 |
| --- | --- |
| `"sk-..."` | 字面量。 |
| `"$ENV"`、`"${ENV}"` | 读取环境变量。 |
| `"!command"` | 执行 shell 命令，使用 stdout；Pi 会缓存命令结果。 |
| `"EMPTY"` | 字面量占位符，适合本地服务或不校验 key 的网关。 |
| `"$$"`、`"$!"` | 分别转义字面量 `$` 和 `!`。 |

如果省略 `api_key`，扩展会生成 `$PI_MODELS_JSONC_<PROVIDER>_API_KEY`。`<PROVIDER>` 会转大写，非字母数字替换为 `_`；例如 provider `lab-server` 对应 `$PI_MODELS_JSONC_LAB_SERVER_API_KEY`。

## Model 字段

字符串模型：

```jsonc
"models": ["openai/gpt-4.1"]
```

等价于：

```jsonc
{
  "model": "openai/gpt-4.1"
}
```

模型对象字段：

| 字段 | 必填 | 默认值 | 可取值 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | 是 | 无 | 非空字符串 | 同时作为 Pi model id、显示匹配 id 和请求体里的 API model 名。 |
| `display_name` | 否 | `model` | 非空字符串 | `/model` 中显示的模型名。 |
| `context_window` | 否 | `128000` | 大于 0 的数字 | 上下文窗口 token 数，影响 Pi 的上下文预算显示。 |
| `max_tokens` | 否 | `16384` | 大于 0 的数字 | 模型最大输出 token，影响 Pi 的模型元数据。 |
| `reasoning_effort` | 否 | 未设置 | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` | 模型默认推理强度。`off` 等价于关闭 reasoning。 |
| `input` | 否 | `["text"]` | `["text"]`、`["text", "image"]` | 模型支持的输入类型。 |
| `defaults` | 否 | `{}` | 见下文 | 模型级默认采样参数；不支持 provider 级 defaults。 |
| `advanced` | 否 | `{}` | 对象 | 模型级高级配置。 |

`reasoning_effort` 的行为：

| 值 | Pi 模型能力 | Pi thinking level | Chat Completions 请求 | Responses 请求 |
| --- | --- | --- | --- | --- |
| 未设置 | `reasoning: false` | 不自动切换 | 不额外注入 | 不额外注入 |
| `off` | `reasoning: false` | 自动设为 `off` | 不额外注入 | 不额外注入 |
| `minimal`/`low`/`medium`/`high`/`xhigh` | `reasoning: true` | 自动设为同名档位 | 注入 `reasoning_effort` | 注入 `reasoning: { "effort": "<值>" }` |

如果 Pi 或 provider compat 已经生成了 `reasoning_effort`、`reasoning`、`thinking`、`enable_thinking` 或 `chat_template_kwargs`，扩展不会再注入 `reasoning_effort`，避免同时发送多套 thinking 参数。

## defaults

`defaults` 只允许写在模型对象里，用于给每次请求补默认采样参数：

```jsonc
{
  "model": "local-model",
  "defaults": {
    "temperature": 0.1,
    "top_p": 0.8,
    "top_k": 40,
    "min_p": 0.05,
    "max_tokens": 8192,
    "presence_penalty": 0,
    "frequency_penalty": 0,
    "repetition_penalty": 1.05,
    "seed": 42,
    "stop": []
  }
}
```

| 字段 | 请求字段 | 可取值 | 说明 |
| --- | --- | --- | --- |
| `temperature` | `temperature` | 数字 | 采样温度。 |
| `top_p` | `top_p` | 数字 | nucleus sampling。 |
| `presence_penalty` | `presence_penalty` | 数字 | OpenAI 标准字段。 |
| `frequency_penalty` | `frequency_penalty` | 数字 | OpenAI 标准字段。 |
| `seed` | `seed` | 数字 | OpenAI-compatible 常见字段。 |
| `stop` | `stop` | 字符串数组 | 停止序列。 |
| `max_tokens` | 见下文 | 数字 | 输出 token 上限。 |
| `top_k` | `top_k` | 数字 | 只在 `local`、`qwen`、`deepseek` preset 下发送。 |
| `min_p` | `min_p` | 数字 | 只在 `local`、`qwen`、`deepseek` preset 下发送。 |
| `repetition_penalty` | `repetition_penalty` | 数字 | 只在 `local`、`qwen`、`deepseek` preset 下发送。 |

`defaults.max_tokens` 的实际请求字段：

| API | compat.maxTokensField | 实际字段 |
| --- | --- | --- |
| `responses` | 忽略 | `max_output_tokens` |
| `chat` | `"max_tokens"` | `max_tokens` |
| `chat` | `"max_completion_tokens"` 或未设置 | `max_completion_tokens` |

provider 级 `defaults`、`temperature`、`top_p`、`top_k`、`min_p`、`max_tokens`、`presence_penalty`、`frequency_penalty`、`repetition_penalty`、`seed`、`stop` 会被拒绝。这样可以避免一个 provider 下不同模型共享错误采样参数。

## advanced

provider 和 model 都支持部分 `advanced` 字段。合并规则是 provider 级先应用，model 级覆盖或追加。

### provider advanced

| 字段 | 可取值 | 实际作用 |
| --- | --- | --- |
| `headers` | `Record<string, string>` | 传给 `pi.registerProvider(...).headers`，由 Pi 按配置值规则解析。适合 `HTTP-Referer`、`User-Agent`、网关鉴权头。 |
| `timeout_ms` | 大于等于 0 的数字 | 请求期传给 Pi stream options 的 `timeoutMs`。 |
| `max_retries` | 大于等于 0 的数字 | 请求期传给 Pi stream options 的 `maxRetries`。 |
| `drop_params` | 字符串数组 | 从最终请求体删除字段。 |
| `extra_body` | 对象 | 合入最终请求体。 |

### model advanced

| 字段 | 可取值 | 实际作用 |
| --- | --- | --- |
| `compat` | 对象 | 覆盖 preset 展开的 `compat` 字段，只影响当前模型。 |
| `drop_params` | 字符串数组 | 追加到 provider 级 `drop_params` 后执行。 |
| `extra_body` | 对象 | 覆盖 provider 级 `extra_body` 同名字段。 |

请求体处理顺序：

1. 从 Pi/OpenAI API 生成原始 payload。
2. 注入模型级 `defaults`。
3. 按 `reasoning_effort` 注入 thinking 参数，前提是 payload 中还没有 thinking 相关字段。
4. 合入 provider 级和 model 级 `extra_body`。
5. 执行 provider 级和 model 级 `drop_params`。
6. 恢复核心字段 `model`、`messages`、`input`、`tools`、`stream`。

`extra_body` 不能包含核心字段 `model`、`messages`、`input`、`tools`、`stream`。这些字段由 Pi 负责生成，扩展不会允许配置覆盖。

示例：

```jsonc
{
  "advanced": {
    "headers": {
      "HTTP-Referer": "https://example.local",
      "User-Agent": "pi-openai-compatible/1.0"
    },
    "drop_params": ["store"],
    "extra_body": {
      "provider": { "only": ["openai"] }
    }
  },
  "models": [
    {
      "model": "m",
      "advanced": {
        "drop_params": ["parallel_tool_calls"],
        "extra_body": { "top_p": 0.9 }
      }
    }
  ]
}
```

最终请求体会删除 `store` 和 `parallel_tool_calls`，并加入 `provider` 与 `top_p`。核心字段不会被删除。

## compat preset

`compat` 是 provider 级高层 preset。扩展会把它展开为 Pi OpenAI-compatible `model.compat` 对象，再和模型级 `advanced.compat` 浅合并。

实际展开值：

```jsonc
{
  "openai": {},
  "openai_compatible": {
    "supportsStore": false,
    "supportsDeveloperRole": false,
    "supportsReasoningEffort": false
  },
  "local": {
    "supportsDeveloperRole": false,
    "supportsReasoningEffort": false,
    "supportsUsageInStreaming": true,
    "maxTokensField": "max_tokens"
  },
  "qwen": {
    "supportsDeveloperRole": false,
    "supportsReasoningEffort": false,
    "supportsUsageInStreaming": true,
    "maxTokensField": "max_tokens",
    "thinkingFormat": "qwen-chat-template"
  },
  "deepseek": {
    "supportsDeveloperRole": false,
    "supportsReasoningEffort": false,
    "supportsUsageInStreaming": true,
    "maxTokensField": "max_tokens",
    "thinkingFormat": "deepseek"
  },
  "strict": {
    "supportsStore": false,
    "supportsDeveloperRole": true,
    "supportsReasoningEffort": true,
    "supportsUsageInStreaming": true
  }
}
```

| preset | 适用场景 | 主要影响 |
| --- | --- | --- |
| `openai` | 标准 OpenAI Chat/Responses 兼容服务。 | 不额外关闭任何 OpenAI 标准能力。 |
| `openai_compatible` | 第三方 OpenAI-compatible 网关默认值。 | 关闭 `store`、developer role 和 Pi 自带 reasoning_effort 发送，降低 400 风险。 |
| `local` | vLLM、SGLang、Ollama、LM Studio。 | 使用 `max_tokens`，允许 streaming usage，关闭 developer role 和 Pi 自带 reasoning_effort。 |
| `qwen` | Qwen chat template thinking。 | 在 `local` 基础上设置 `thinkingFormat: "qwen-chat-template"`。 |
| `deepseek` | DeepSeek thinking。 | 在 `local` 基础上设置 `thinkingFormat: "deepseek"`。 |
| `strict` | 调试或确认服务完整支持 OpenAI 字段。 | 保留 developer role 和 Pi 自带 reasoning_effort；仍关闭 `store`。 |

`top_k`、`min_p`、`repetition_penalty` 是否发送只看 provider 级 preset 是否是 `local`、`qwen`、`deepseek`。模型级 `advanced.compat` 不会改变这个判断。

模型级覆盖示例：

```jsonc
{
  "compat": "openai_compatible",
  "models": [
    {
      "model": "m",
      "advanced": {
        "compat": {
          "supportsDeveloperRole": true,
          "maxTokensField": "max_tokens"
        }
      }
    }
  ]
}
```

该模型最终 compat 等于 `openai_compatible` preset 加上覆盖字段：

```jsonc
{
  "supportsStore": false,
  "supportsDeveloperRole": true,
  "supportsReasoningEffort": false,
  "maxTokensField": "max_tokens"
}
```

## 示例

### 最小本地 vLLM

```jsonc
{
  "providers": {
    "vllm": {
      "display_name": "Local vLLM",
      "base_url": "http://127.0.0.1:8000/v1",
      "api_key": "EMPTY",
      "api": "chat",
      "compat": "local",
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
      "display_name": "OpenRouter",
      "base_url": "https://openrouter.ai/api/v1",
      "api_key": "$OPENROUTER_API_KEY",
      "api": "chat",
      "compat": "openai_compatible",
      "models": [
        "openai/gpt-4.1",
        {
          "model": "deepseek/deepseek-r1",
          "display_name": "DeepSeek R1",
          "context_window": 131072,
          "max_tokens": 32768,
          "reasoning_effort": "high",
          "defaults": {
            "temperature": 0.2,
            "top_p": 0.95,
            "max_tokens": 8192
          }
        }
      ],
      "advanced": {
        "headers": {
          "HTTP-Referer": "https://example.local"
        },
        "drop_params": ["store"]
      }
    }
  }
}
```

### Qwen 本地服务

```jsonc
{
  "providers": {
    "qwen-local": {
      "display_name": "Qwen Local",
      "base_url": "http://127.0.0.1:8000/v1",
      "api_key": "EMPTY",
      "api": "chat",
      "compat": "qwen",
      "models": [
        {
          "model": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
          "display_name": "Qwen3 Coder",
          "context_window": 262144,
          "max_tokens": 32768,
          "reasoning_effort": "high",
          "defaults": {
            "temperature": 0.1,
            "top_p": 0.8,
            "top_k": 40,
            "max_tokens": 8192
          }
        }
      ]
    }
  }
}
```

### Responses API

```jsonc
{
  "providers": {
    "responses-gateway": {
      "display_name": "Responses Gateway",
      "base_url": "https://gateway.example.com/v1",
      "api_key": "$RESPONSES_GATEWAY_API_KEY",
      "api": "responses",
      "compat": "openai",
      "models": [
        {
          "model": "gpt-5.2",
          "reasoning_effort": "medium",
          "defaults": { "max_tokens": 8192 }
        }
      ]
    }
  }
}
```

该模型请求 Responses API 时会把 `defaults.max_tokens` 写成 `max_output_tokens`，并把 `reasoning_effort: "medium"` 写成：

```jsonc
{
  "reasoning": { "effort": "medium" }
}
```

## 验证

列出模型：

```bash
pi --list-models lab-server --offline
```

如果模型不出现在 `/model` 或 `--list-models`：

1. 确认 `~/.pi/agent/models.jsonc` 存在且 JSONC 可解析。
2. 确认 provider 有可解析的 `api_key`，本地服务可用 `"EMPTY"`。
3. 确认 `models` 非空，且模型 id 未重复。
4. 启动时报 schema 错误时，按错误里的 `providers.<id>...` path 修改字段。

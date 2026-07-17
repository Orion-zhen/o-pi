# OpenAI-compatible provider

本扩展从私有配置文件注册自定义 OpenAI-compatible provider：

```text
~/.pi/agent/models.jsonc
```

自动发现结果缓存于 `~/.pi/agent/.cache/openai-compatible-models.json`。缓存只包含公开模型元数据和 endpoint 哈希，不包含 API key、header 或 endpoint URL。

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
      "thinking": "openai",
      "models_endpoint": "models",
      "models": [
        "model-id",
        {
          "model": "other-model-id",
          "display_name": "Other Model",
          "context_window": 128000,
          "max_tokens": 16384,
          "thinking_level": "off",
          "thinking_level_map": {
            "off": "none",
            "xhigh": "max"
          },
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

如果 provider key 与 Pi 内置 provider 同名，插件 provider 会覆盖内置 provider：该 provider 的内置模型列表会被移除，只保留 `models.jsonc` 中注册出的模型，请求也走本扩展的 OpenAI-compatible 适配。例如自定义 `opencode` 后，Pi 内置 `opencode` 模型不再出现在 `/model`。

## Provider 字段

| 字段 | 必填 | 默认值 | 可取值 | 说明 |
| --- | --- | --- | --- | --- |
| `display_name` | 否 | provider id | 非空字符串 | `/model` 中显示的 provider 名称。 |
| `base_url` | 是 | 无 | 非空 URL 字符串 | OpenAI-compatible endpoint，一般以 `/v1` 结尾。会传给 `pi.registerProvider(...).baseUrl`。 |
| `api_key` | 否 | `$PI_MODELS_JSONC_<PROVIDER>_API_KEY` | 字符串 | API key 配置值，会传给 Pi 的 provider auth 解析逻辑。 |
| `api` | 否 | `chat` | `chat`、`responses` | `chat` 注册为 `openai-completions`；`responses` 注册为 `openai-responses`。 |
| `compat` | 否 | `openai_compatible` | `openai`、`openai_compatible`、`local`、`qwen`、`deepseek`、`strict` | 高层兼容 preset，展开后传给每个模型的 `compat`。 |
| `thinking` | 否 | `none` | 见“thinking preset” | provider 如何把 Pi thinking level 编码成 OpenAI-compatible 请求字段。它与 `api` 独立。 |
| `models_endpoint` | 否 | `models` | 相对路径或完整 URL | 自动发现请求的模型列表接口；默认把 `models` 拼到 `base_url` 后。 |
| `models` | 否 | `"auto"` | `"auto"` 或非空数组 | 省略/`"auto"` 时仅使用缓存/发现结果；数组立即注册并追加缓存/发现模型。同模型 id 冲突时手写配置优先。provider 内模型 id 不能重复。 |
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

## 自动发现模型

扩展启动时只读取本地缓存，不等待网络。进入 session 后会在后台并发请求所有 provider 的 models endpoint；成功结果原子写入缓存并更新 Pi model registry，单个 provider 失败时继续使用它的旧缓存。

Pi 当前的内置 `/model` selector 打开后不会重新读取 registry，扩展也无法查询 selector 是否正在显示。后台成功刷新保持静默；如果刷新恰好发生在 selector 打开期间，下次打开时会看到新列表。也可以手动执行：

```text
/refresh-models
```

`PI_OFFLINE=1` 或 `--offline` 会跳过自动和手动刷新，只使用手写模型与现有缓存。

`models` 省略或写成 `"auto"` 时，只使用缓存/发现结果。首次运行且尚无缓存时，该 provider 会在后台发现成功后出现：

```jsonc
{
  "providers": {
    "lab-server": {
      "display_name": "Lab Server",
      "base_url": "https://lab.example.com/v1",
      "api_key": "$LAB_API_KEY",
      "models": "auto"
    }
  }
}
```

默认请求 URL 是 `base_url` 后拼 `models`，例如 `https://lab.example.com/v1/models`。特殊网关可用 `models_endpoint` 覆盖；相对路径按 `base_url` 解析，完整 URL 会直接使用。

`models` 写成数组时，数组中的手写模型会在启动时立即可用，再追加缓存/endpoint 发现到的其他模型；如果 endpoint 返回同一个 model id，忽略 endpoint 里的那一项，手写配置完整优先：

```jsonc
{
  "providers": {
    "lab-server": {
      "base_url": "https://lab.example.com/v1",
      "api_key": "$LAB_API_KEY",
      "models": [
        {
          "model": "qwen3-coder",
          "display_name": "Qwen3 Coder Tuned",
          "context_window": 262144,
          "max_tokens": 32768
        }
      ]
    }
  }
}
```

请求会带 `Accept: application/json`，并在未配置 `Authorization`/`CF-AIG-Authorization` header 时用 `api_key` 生成 `Authorization: Bearer <key>`；`api_key: "EMPTY"` 不发送 Authorization，适合本地服务。`advanced.headers` 同样会用于发现请求。

支持标准 OpenAI 形态：

```jsonc
{ "data": [{ "id": "model-id" }] }
```

也支持顶层数组或 `{ "models": [...] }`。自动发现会读取常见元数据：`name`/`display_name`、`context_length`/`context_window`、`max_completion_tokens`/`max_output_tokens`、`architecture.input_modalities` 中的 `image`/`vision`。

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
| `thinking_level` | 否 | 未设置 | Pi `ModelThinkingLevel` | 模型被用户选中时使用的默认 thinking level；当前为 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`。 |
| `thinking_level_map` | 否 | 未设置 | Pi `ThinkingLevelMap` | 把 Pi thinking level 映射成 provider 值；字符串表示上游值，`null` 表示不支持。 |
| `input` | 否 | `["text"]` | `["text"]`、`["text", "image"]` | 模型支持的输入类型。 |
| `defaults` | 否 | `{}` | 见下文 | 模型级默认采样参数；不支持 provider 级 defaults。 |
| `advanced` | 否 | `{}` | 对象 | 模型级高级配置。 |

当 `input` 包含 `"image"` 时，Pi 的 OpenAI API 适配层会把内部 `ImageContent` 转成对应请求格式：Chat Completions 使用 `image_url.url: "data:<mime>;base64,<data>"`，Responses 使用 `type: "input_image"` 和 `image_url: "data:<mime>;base64,<data>"`。扩展只保留这些核心 payload 字段，不把图片 base64 拼入文本。

`thinking_level` 和 `thinking_level_map` 直接使用 Pi 的模型思考能力语义：

- 两个字段都省略时，模型注册为 `reasoning: false`。
- 任意一个字段存在时，模型注册为 `reasoning: true`；所以 `thinking_level: "off"` 仍允许用户之后切换到其他等级。
- `thinking_level` 只是模型默认值。扩展仅在用户主动选择模型时设置一次；恢复 session、每轮请求和用户手动切换 thinking level 时都不会重新覆盖。
- `thinking_level_map` 原样传给 Pi。省略某个键表示使用 Pi/provider 默认映射；字符串表示发给 provider 的值；`null` 会让 Pi 隐藏并跳过该等级。
- Pi 默认不公开 `xhigh`；要使用它必须显式提供映射，例如 `"xhigh": "max"`。
- 默认等级必须是 Pi 根据 `thinking_level_map` 判定为受支持的等级，否则配置加载失败。

示例：

```jsonc
{
  "model": "reasoning-model",
  "thinking_level": "xhigh",
  "thinking_level_map": {
    "off": "none",
    "minimal": null,
    "xhigh": "max"
  }
}
```

Pi 会隐藏 `minimal`，选中该模型时默认使用 `xhigh`；采用 effort 型 preset 时，provider 收到的值是 `max`。

旧的模型字段 `reasoning_effort` 已删除，不提供兼容层；迁移时把它改名为 `thinking_level`，并在 provider 上选择 `thinking` preset。旧 `compat: "qwen"`、`compat: "deepseek"` 不再隐式决定思考参数格式。所有多词 `thinking` preset 均使用 snake_case；Pi 原生 `compat.thinkingFormat` 的连字符值只存在于内部映射。

## thinking preset

`thinking` 是 provider 级请求编码预设，默认 `none`。`api` 只决定 Chat Completions 或 Responses endpoint；`thinking` 独立决定请求体参数形状。因此 Responses endpoint 也可以使用 `chat_template_effort`。

| preset | 开启时的主要请求字段 | 关闭时的行为 |
| --- | --- | --- |
| `none` | 不发送控制字段 | 不发送控制字段 |
| `openai` | Chat：`reasoning_effort`；Responses：`reasoning.effort` | 使用 `thinking_level_map.off`；Responses 默认 `none` |
| `openrouter` | `reasoning: { effort }` | 默认 `reasoning: { effort: "none" }` |
| `deepseek` | `thinking: { type: "enabled" }`；compat 允许时附加 `reasoning_effort` | `thinking: { type: "disabled" }` |
| `together` | `reasoning: { enabled: true }`；compat 允许时附加 `reasoning_effort` | `reasoning: { enabled: false }` |
| `zai` | `thinking: { type: "enabled", clear_thinking: false }` | `thinking: { type: "disabled" }` |
| `qwen` | `enable_thinking: true` | `enable_thinking: false` |
| `qwen_chat_template` | `chat_template_kwargs.enable_thinking: true`，并设置 `preserve_thinking: true` | `enable_thinking: false` |
| `chat_template_enabled` | 任意非 `off` 等级发送 `chat_template_kwargs.enable_thinking: true` | `off` 发送 `enable_thinking: false` |
| `chat_template_effort` | `chat_template_kwargs.reasoning_effort` | Chat 默认省略，Responses 默认传递 `none`；可由 `thinking_level_map.off` 覆盖或禁用 |
| `string_thinking` | 顶层 `thinking: "<level>"` | 默认 `thinking: "none"` |
| `ant_ling` | 仅在 `thinking_level_map` 为当前等级给出字符串时发送 `reasoning: { effort }` | 不发送 |

Chat API 的预设直接展开成 Pi 原生 `compat.thinkingFormat`、`chatTemplateKwargs` 和 `supportsReasoningEffort`。Responses API 原生只支持 OpenAI 的 `reasoning.effort`；使用其他预设时，扩展会删除 Pi 生成的 OpenAI reasoning 控制字段，再按预设写入一种参数格式，避免同时发送多套 thinking 参数。

`chat_template_enabled` 是布尔型控制，不需要配置 `thinking_level_map`：`off` 表示关闭，Pi 当前等级为 `minimal`、`low`、`medium`、`high` 或可用的 `xhigh` 时都表示开启。`thinking_level_map` 仅在需要隐藏某些 Pi 等级时使用；`xhigh` 是否可选仍遵循 Pi 原生规则。

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
3. Responses API 使用非 `openai` thinking preset 时，把 Pi 当前 thinking level 转换成预设参数格式。
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

`compat` 是 provider 级协议兼容 preset。扩展依次合并 `compat` preset、`thinking` preset 和模型级 `advanced.compat`，后者优先级最高。思考参数形状只由独立的 `thinking` 字段选择。

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
    "maxTokensField": "max_tokens"
  },
  "deepseek": {
    "supportsDeveloperRole": false,
    "supportsReasoningEffort": false,
    "supportsUsageInStreaming": true,
    "maxTokensField": "max_tokens"
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
| `qwen` | 需要本地采样字段的 Qwen-compatible 服务。 | 使用 `max_tokens`，允许非标准采样字段；思考格式另用 `thinking`。 |
| `deepseek` | 需要本地采样字段的 DeepSeek-compatible 服务。 | 使用 `max_tokens`，允许非标准采样字段；思考格式另用 `thinking`。 |
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

该模型最终 compat 等于 `openai_compatible`、默认的 `thinking: "none"`，再加上覆盖字段：

```jsonc
{
  "supportsStore": false,
  "supportsDeveloperRole": true,
  "supportsReasoningEffort": false,
  "thinkingFormat": "openai",
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

### 自动发现本地 vLLM 模型

```jsonc
{
  "providers": {
    "vllm-auto": {
      "display_name": "Local vLLM Auto",
      "base_url": "http://127.0.0.1:8000/v1",
      "api_key": "EMPTY",
      "api": "chat",
      "compat": "local",
      "models": "auto"
    }
  }
}
```

启动后会在后台请求 `http://127.0.0.1:8000/v1/models`，后续启动先使用上次成功缓存。

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
      "thinking": "openrouter",
      "models": [
        "openai/gpt-4.1",
        {
          "model": "deepseek/deepseek-r1",
          "display_name": "DeepSeek R1",
          "context_window": 131072,
          "max_tokens": 32768,
          "thinking_level": "high",
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
      "thinking": "qwen_chat_template",
      "models": [
        {
          "model": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
          "display_name": "Qwen3 Coder",
          "context_window": 262144,
          "max_tokens": 32768,
          "thinking_level": "high",
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
      "thinking": "openai",
      "models": [
        {
          "model": "gpt-5.2",
          "thinking_level": "medium",
          "defaults": { "max_tokens": 8192 }
        }
      ]
    }
  }
}
```

该模型请求 Responses API 时会把 `defaults.max_tokens` 写成 `max_output_tokens`，并把 Pi 当前的 `thinking_level: "medium"` 写成：

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
3. 手写 `models` 数组时确认模型 id 未重复。
4. 执行 `/refresh-models`，确认 `base_url`/`models_endpoint` 能访问。返回需为 `{ "data": [{ "id": "..." }] }`、数组或 `{ "models": [...] }`。
5. 刷新失败时检查提示中的 provider；旧缓存会继续保留。必要时重新打开 `/model` 查看刷新后的列表。

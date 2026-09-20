# 配置示例

## 本地 vLLM 或 llama.cpp

```jsonc
{
  "providers": {
    "local": {
      "name": "本地模型",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "apiKey": "EMPTY",
      "api": "openai-completions",
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": true,
        "maxTokensField": "max_tokens"
      },
      "models": ["Qwen/Qwen3-Coder-480B-A35B-Instruct"]
    }
  }
}
```

## llama-swap 模型后缀

```jsonc
{
  "providers": {
    "llama-swap": {
      "name": "本地 llama-swap",
      "baseUrl": "http://127.0.0.1:8080/v1",
      "apiKey": "EMPTY",
      "api": "openai-completions",
      "thinkingPreset": "model-suffix",
      "models": "auto"
    }
  }
}
```

如果目录包含 `model`、`model:off`、`model:high` 和 `model:max`，Pi 只显示 `model`。切换 Pi 思考级别后，扩展会把请求路由到对应的后缀变体。

## OpenRouter

```jsonc
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "$OPENROUTER_API_KEY",
      "api": "openai-completions",
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
          "maxTokens": 8192,
          "defaultThinkingLevel": "high",
          "samplingParams": {
            "temperature": 0.2,
            "top_p": 0.95
          }
        }
      ],
      "dropParams": ["store"]
    }
  }
}
```

## OpenAI Responses 兼容服务

```jsonc
{
  "providers": {
    "responses": {
      "baseUrl": "https://example.com/v1",
      "apiKey": "$RESPONSES_API_KEY",
      "api": "openai-responses",
      "thinkingPreset": "chat-template-effort",
      "models": [
        {
          "id": "reasoning-model",
          "reasoning": true,
          "defaultThinkingLevel": "xhigh",
          "thinkingLevelMap": {
            "off": "none",
            "xhigh": "max"
          }
        }
      ]
    }
  }
}
```

## 模型专用端点和请求头

```jsonc
{
  "providers": {
    "gateway": {
      "baseUrl": "https://gateway.example.com/v1",
      "apiKey": "$GATEWAY_API_KEY",
      "headers": {
        "X-Account": "$ACCOUNT"
      },
      "models": [
        {
          "id": "special-model",
          "baseUrl": "https://model.example.com/v1",
          "headers": {
            "X-Model": "$MODEL_HEADER"
          }
        }
      ]
    }
  }
}
```

## 自动发现与手写配置优先级

```jsonc
{
  "providers": {
    "gateway": {
      "baseUrl": "https://gateway.example.com/v1",
      "apiKey": "$GATEWAY_API_KEY",
      "modelsEndpoint": "models",
      "models": [
        { "id": "preferred", "name": "首选名称" }
      ]
    }
  }
}
```

端点必须返回 `{ "data": [...] }`。每个条目是包含非空 `id` 的对象。端点可以通过 `context_length` 和 `architecture.input_modalities` 补充 `preferred` 缺少的上下文窗口和图片输入能力，并追加远端独有模型。手写配置中的 `name` 保持不变。

## 缓存保温与压缩预算

已确认服务端缓存寿命时，可在模型对象中声明 `"promptCache": { "short": 300, "long": 3600 }`，单位为秒。只填写实际支持的档位，并配置准确的 `cost`。未声明当前档位寿命的模型不会保温。

Pi 在全局 `~/.pi/agent/settings.json` 中默认使用 `"cacheWarming": "streaming"`，仅在长工具执行期间按成本收益刷新。`"idle"` 额外考虑空闲刷新，`"off"` 禁用。刷新会产生费用，opi 将其计入会话总量并单独展示，不计入对话轮次或缓存命中率。

压缩预算也使用 Pi 原生设置，无需在 `models.jsonc` 重复配置。例如：

```json
{
  "compaction": {
    "modelOverrides": {
      "local/small-model": { "reserveTokens": 2048, "keepRecentTokens": 4096 }
    }
  }
}
```

键必须精确匹配 `provider/modelId`。两个预算独立覆盖，未填写的字段沿用普通压缩设置。

## 通过命令获取密钥

```jsonc
{
  "providers": {
    "vault": {
      "baseUrl": "https://example.com/v1",
      "apiKey": "!op read op://Private/provider/key",
      "models": ["model-id"]
    }
  }
}
```

扩展在解析凭证或发送请求时执行命令。扩展会去除标准输出的首尾空白，并在进程内缓存结果。不要把不可信内容拼接到命令中。

完整字段说明见[配置模式](schema.md)。认证规则见[认证和敏感配置](authentication.md)。

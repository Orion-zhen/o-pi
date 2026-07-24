# 配置示例

## 本地 vLLM 或 llama.cpp

```jsonc
{
  "providers": {
    "local": {
      "name": "Local AI",
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

## OpenAI Responses-compatible 服务

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

## 模型级 endpoint 和 header

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

## 自动发现和手写覆盖

```jsonc
{
  "providers": {
    "gateway": {
      "baseUrl": "https://gateway.example.com/v1",
      "apiKey": "$GATEWAY_API_KEY",
      "modelsEndpoint": "models",
      "models": [
        { "id": "preferred", "name": "Preferred name" }
      ]
    }
  }
}
```

endpoint 可以补充 `preferred` 的上下文和 modality，并追加远端独有模型；手写 name 仍然优先。

## Command 获取 key

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

command 会在请求边界执行并在进程内缓存 stdout。不要把不可信内容拼进 command。

完整字段说明见 [schema.md](schema.md)，认证规则见 [authentication.md](authentication.md)。

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

端点可以补充 `preferred` 缺少的上下文窗口和输入类型，并追加远端独有的模型。手写配置中的 `name` 保持不变。

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

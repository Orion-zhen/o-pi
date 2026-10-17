# OpenAI 兼容提供方

使用 Pi 原生 `~/.pi/agent/models.json` 配置服务。普通静态 provider 完全交给 SDK。扩展只在启用自动发现、思考转换或请求参数调整时注册完整原生 `Provider`。单独配置 `defaultThinkingLevel` 只处理模型选择事件，不替换原生 provider。

自定义字段直接放在 provider、`models` 或 `modelOverrides` 中，不需要包装对象。不会读取旧的 `models.jsonc`，也不会自动迁移或改写用户文件。

## 静态服务

```json
{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "models": [{ "id": "model-id" }]
    }
  }
}
```

无认证服务也按 SDK 约定配置占位密钥，服务需允许或忽略 `Authorization: Bearer local`。`EMPTY` 不再有特殊含义。认证、请求头、模型覆盖和采样参数均遵循 SDK 行为。

## 自动发现与模型后缀

```json
{
  "providers": {
    "llama-swap": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "discoverModels": true,
      "thinkingPreset": "model-suffix",
      "modelOverrides": {
        "model-id": { "name": "Local model", "maxTokens": 32768 }
      }
    }
  }
}
```

`discoverModels: true` 启用 `GET <baseUrl>/models`。`model-suffix` 将发现的 `model-id:off`、`model-id:high` 等变体折叠到基础模型，并按当前思考级别路由请求。缓存恢复、持久化和并发发布由 SDK `createProvider({ fetchModels })` 管理。

发现模型的手写调整应使用原生 `modelOverrides`。`models` 是完整模型定义，会替换同名发现模型，而不是仅补充字段。

## 非标准 Responses 思考字段

```json
{
  "providers": {
    "gateway": {
      "baseUrl": "https://example.com/v1",
      "api": "openai-responses",
      "apiKey": "$GATEWAY_API_KEY",
      "thinkingPreset": "deepseek",
      "models": [{ "id": "reasoning-model", "reasoning": true }]
    }
  }
}
```

未配置 `thinkingPreset` 时保留 SDK 原生请求。Chat Completions 使用原生 `compat.thinkingFormat` 和 `compat.chatTemplateKwargs`，不再从普通思考预设生成 compat。`model-suffix` 对两种 API 都有效。

## 详细说明

示例见 [`agent/models.example.jsonc`](../../agent/models.example.jsonc)。OpenRouter 等内置服务优先使用原生 provider，不要为了普通配置覆盖而启用此扩展。同名扩展注册会替换内置实现。

- [配置加载](configuration.md)
- [字段](schema.md)
- [认证](authentication.md)
- [兼容选项](compatibility.md)
- [思考编码](thinking.md)
- [请求体处理](payload.md)
- [自动发现](discovery.md)
- [示例](examples.md)
- [故障排查](troubleshooting.md)

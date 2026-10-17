# OpenAI 兼容提供方

使用 Pi 原生 `~/.pi/agent/models.json` 配置服务。普通静态 provider 完全交给 SDK。扩展只在启用思考转换或请求参数调整时注册完整原生 `Provider`。单独配置 `defaultThinkingLevel` 只处理模型选择事件，不替换原生 provider。

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

## 模型后缀

```json
{
  "providers": {
    "llama-swap": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "thinkingPreset": "model-suffix",
      "models": [{
        "id": "model-id",
        "reasoning": true,
        "thinkingLevelMap": {
          "off": "off", "minimal": null, "low": null, "medium": null,
          "high": "high", "xhigh": null, "max": null
        }
      }]
    }
  }
}
```

`model-suffix` 按当前思考等级将请求路由到 `model-id:off`、`model-id:high` 等 ID。只配置基础模型。GUI 根据候选 ID 自动补全思考能力和等级映射，手写配置时需显式声明。

GUI 的模型服务设置自动读取 `GET <baseUrl>/models` 作为添加候选。选中候选或手动填写 ID 后写入 `models`，保存并重载后生效。候选不会自动注册，harness 不请求或缓存该列表。

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

两种 API 统一使用 `thinkingPreset`。省略时继承，`auto` 保留 SDK 默认行为，`none` 不发送思考控制参数。Chat Completions 的厂商格式交给 SDK 编码，Responses 的非标准格式由 harness 转换。`model-suffix` 对两种 API 都有效。

## 详细说明

示例见 [`agent/models.example.jsonc`](../../agent/models.example.jsonc)。OpenRouter 等内置服务优先使用原生 provider，不要为了普通配置覆盖而启用此扩展。同名扩展注册会替换内置实现。

- [配置加载](configuration.md)
- [字段](schema.md)
- [认证](authentication.md)
- [兼容选项](compatibility.md)
- [思考传递方式](thinking.md)
- [请求体处理](payload.md)
- [示例](examples.md)
- [故障排查](troubleshooting.md)

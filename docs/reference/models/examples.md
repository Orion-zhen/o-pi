# 配置示例

完整示例见 [`agent/models.example.jsonc`](../../../agent/models.example.jsonc)。将需要的服务合并到 `~/.pi/agent/models.json`，保留已有配置。

示例包含：

- `llama-cpp`：静态模型和自定义思考模板。
- `responses-demo`：原生 Responses reasoning 及模型级默认思考等级。
- `chat-template-enabled-demo`：使用原生 chatTemplateKwargs 的布尔思考模板。

可选 compat 字段放在注释中，按服务实际能力启用。

## 静态模型的自定义采样

```json
{
  "id": "qwen-model",
  "reasoning": true,
  "samplingParams": { "temperature": 1, "top_p": 0.95 },
  "samplingParamsByThinkingLevel": {
    "off": { "temperature": 0.7 },
    "high": { "top_k": 20 }
  },
  "compat": { "thinkingFormat": "qwen" }
}
```

## 配置模型能力和扩展选项

```json
{
  "models": [{
    "id": "reasoning-model",
    "reasoning": true,
    "compat": { "thinkingFormat": "deepseek" },
    "defaultThinkingLevel": "high"
  }]
}
```

两个示例的 `compat.thinkingFormat` 用于 Chat Completions。Responses 使用 SDK 原生编码，等级映射见[思考传递](thinking.md)。

压缩预算和全局思考默认值放在 Pi 原生 settings.json 中。

# 配置示例

完整示例见 [`agent/models.example.jsonc`](../../agent/models.example.jsonc)。将所需 provider 合并到 `~/.pi/agent/models.json`，不要直接覆盖已有配置。

示例包含：

- `llama-cpp`：普通静态服务，仅使用原生字段，不注册扩展 provider。
- `llama-swap`：显式自动发现、`model-suffix` 和原生 `modelOverrides`。
- `responses-demo`：非标准 Responses 思考转换及模型级默认思考等级。
- `chat-template-enabled-demo`：原生布尔思考模板，替代旧的 Chat Completions 思考预设。

示例保留字段说明，并将服务特有的可选 compat 字段放在注释中。按服务实际能力取消注释，不要全部启用。

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

## 为发现模型补充能力和扩展选项

```json
{
  "discoverModels": true,
  "modelOverrides": {
    "reasoning-model": {
      "reasoning": true,
      "maxTokens": 32768,
      "thinkingPreset": "deepseek",
      "defaultThinkingLevel": "high"
    }
  }
}
```

第二个示例中的普通 `thinkingPreset` 用于 Responses。Chat Completions 应配置对应的原生 compat。

压缩预算、全局思考默认值等继续放在 Pi 原生设置中，不在模型配置中重复维护。

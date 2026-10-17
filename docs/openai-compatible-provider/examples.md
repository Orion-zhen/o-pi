# 配置示例

完整示例见 [`agent/models.example.jsonc`](../../agent/models.example.jsonc)。将所需 provider 合并到 `~/.pi/agent/models.json`，不要直接覆盖已有配置。

示例包含：

- `llama-cpp`：静态模型和自定义思考模板。
- `llama-swap`：显式模型定义和 `model-suffix` 路由。
- `responses-demo`：非标准 Responses 思考转换及模型级默认思考等级。
- `chat-template-enabled-demo`：布尔思考预设，由 SDK 展开模板。

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
  "thinkingPreset": "qwen"
}
```

## 配置模型能力和扩展选项

```json
{
  "models": [{
    "id": "reasoning-model",
    "reasoning": true,
    "thinkingPreset": "deepseek",
    "defaultThinkingLevel": "high"
  }]
}
```

两个示例的 `thinkingPreset` 均适用于 Chat Completions 和 Responses。

压缩预算、全局思考默认值等继续放在 Pi 原生设置中，不在模型配置中重复维护。

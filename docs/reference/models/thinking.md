# 思考传递方式

Chat Completions 和 Responses 使用 thinkingPreset。优先级为 modelOverrides、models、provider。省略表示继承，auto 恢复 SDK 默认，none 清理请求中的思考控制字段。

推理能力通过 reasoning 显式声明，thinkingLevelMap 定义等级可用性和提供方值。

## Chat Completions

厂商格式由 SDK 编码，扩展将预设转换为运行时 compat.thinkingFormat。

支持 openai、openrouter、deepseek、together、baseten、zai、qwen、chat-template、qwen-chat-template、string-thinking 和 ant-ling。

chat-template 使用 compat.chatTemplateKwargs，baseten 使用 compat.chatTemplateArgs。chat-template-enabled 和 chat-template-effort 分别生成布尔开关与 effort 模板。未显式映射 off 时，effort 模板在关闭思考时省略该参数。

## Responses

baseten 和 chat-template 仅适用于 Chat Completions。Responses 支持：

| 预设 | 请求字段 |
| --- | --- |
| auto、openai | SDK 原生 reasoning |
| none | 清理思考控制字段 |
| openrouter | reasoning.effort |
| deepseek | thinking.type |
| together | reasoning.enabled |
| zai | thinking.type，启用时 clear_thinking 为 false |
| qwen | enable_thinking |
| qwen-chat-template | chat_template_kwargs.enable_thinking、preserve_thinking |
| chat-template-enabled | chat_template_kwargs.enable_thinking |
| chat-template-effort | chat_template_kwargs.reasoning_effort |
| string-thinking | 字符串 thinking |
| ant-ling | 启用且显式映射时发送 reasoning.effort |

非标准转换只作用于推理模型，先清理 SDK 思考字段和 reasoning.encrypted_content，再按当前等级映射生成字段。DeepSeek、Together 和 Z.ai 需显式设置 supportsReasoningEffort 为 true 才附带 reasoning_effort。

## model-suffix

两种 API 均可用。请求按 Pi 等级名生成 `model-id:<level>`，只需注册基础模型。

```json
{
  "thinkingPreset": "model-suffix",
  "models": [{
    "id": "local-model",
    "reasoning": true,
    "thinkingLevelMap": {
      "off": "off", "minimal": null, "low": null, "medium": null,
      "high": "high", "xhigh": null, "max": null
    }
  }]
}
```

没有 off 后缀变体时，关闭思考使用基础模型。显式映射为 null 的等级不追加后缀。

GUI 根据 `/models` 候选合并后缀变体，为已选模型补全尚未配置的能力与等级。缺失后缀默认禁用，存在基础 ID 时可用它表示 off。已有配置优先，重新推导可点击“恢复默认映射”。

没有候选或显式映射时采用 SDK 等级规则。推理模型的 off、minimal、low、medium、high 默认可用，xhigh 和 max 需要显式启用。

后缀路由在附加与删除请求参数之后运行，再清理思考字段。请求顺序见[请求体处理](payload.md)。

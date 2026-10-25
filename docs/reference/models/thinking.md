# 思考传递方式

思考控制使用 SDK 原生配置。`reasoning` 声明思考能力，`thinkingLevelMap` 定义等级可用性和提供方值。

## Chat Completions

`compat.thinkingFormat` 选择 SDK 编码。优先级为 modelOverrides、models、provider，均未配置时由 SDK 根据服务商和地址选择。

支持 openai、openrouter、deepseek、together、baseten、zai、qwen、chat-template、qwen-chat-template、string-thinking 和 ant-ling。

chat-template 使用 `compat.chatTemplateKwargs`，baseten 使用 `compat.chatTemplateArgs`。模板参数按参数名继承，同名参数的值整体替换。覆盖变量对象时，省略 `omitWhenOff` 表示不再启用该选项。

变量由 SDK 展开：

```json
{
  "compat": {
    "thinkingFormat": "chat-template",
    "chatTemplateKwargs": {
      "enable_thinking": { "$var": "thinking.enabled" },
      "reasoning_effort": { "$var": "thinking.effort", "omitWhenOff": true }
    }
  }
}
```

`thinking.enabled` 生成开关，`thinking.effort` 使用等级映射，`thinking.budget` 使用思考预算。

在 off 等级，`thinking.enabled` 为 false。未显式映射 off 时，`thinking.effort` 省略，不影响关闭开关的发送。变量设置 `omitWhenOff: true` 后，在 off 时始终省略该项。

## Responses

使用 SDK 原生 `reasoning`，等级值由 `thinkingLevelMap` 映射。`compat.thinkingFormat` 不参与 Responses 编码。

## 等级与模型

未显式配置等级映射时采用 SDK 默认规则。推理模型的 off、minimal、low、medium、high 默认可用，xhigh 和 max 需要显式启用。映射值为 null 表示该等级不可用。

模型 ID 按配置原样发送，不随思考等级变化。GUI 按 `/models` 返回的原始 ID 展示候选，不从名称推导能力或等级。

## 设置页

Chat Completions 显示“思考格式”选择器，模型内位于“思考能力”下方。选择结果写入 `compat.thinkingFormat`，重置删除本层覆盖并恢复继承。Responses 不显示此选择器。

模型的有效 API 不是 `openai-completions` 或 `openai-responses` 时，不显示 OpenAI 协议控件和思考等级映射表，也不推导这两种协议的默认值。原配置保留并交由 SDK 处理，默认思考等级仍可设置。

`chatTemplateKwargs` 和 `chatTemplateArgs` 使用参数表单，表头为“模板参数”和“取值类型”。参数名、变量名和 `omitWhenOff` 保留英文标识。可快捷添加 `enable_thinking`、`reasoning_effort` 和布尔值为 `true` 的 `preserve_thinking`，也可新增自定义参数。取值支持三种 `thinking.*` 变量，以及 string、number、boolean、null。

新增或编辑后点击“添加”或“应用”，再保存设置。继承项可在当前层覆盖并重置，本层新增项可删除。继承参数的名称需在上层修改。

字段可用性由 API、有效格式和继承后的 compat 推导，不探测远端能力：

- “opi 可选”控制本地等级列表，与服务商映射值分开。默认思考等级只能选择当前可用等级。
- 仅允许编辑编码器会使用的映射。qwen-chat-template 显示开启或关闭，不提供等级值输入。
- Chat Completions 的独立 reasoning_effort 开关只在当前编码使用该参数时可编辑。off 与其他等级分别判断，自定义模板检查 thinking.effort 和 omitWhenOff。
- 未开启思考能力时禁用等级设置。切换格式保留模板参数和等级映射，只显示当前格式使用的模板参数。当前格式不发送等级值时只显示请求行为，等级启用状态和映射覆盖仍可重置。

这些状态描述客户端的请求编码。服务端是否采纳参数仍需查阅服务文档，额外请求参数可以覆盖或删除已编码的字段。请求顺序见[请求体处理](payload.md)。

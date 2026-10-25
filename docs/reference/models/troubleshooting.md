# 模型排障

## 模型没有显示

1. 检查 `models.json` 路径、配置错误与认证。
2. 确认 models 为对象数组，每项包含 id，并配置 API 类型。
3. GUI 候选需先添加到配置。
4. 保存后重载当前会话。

启用扩展请求改写的服务需要 baseUrl 和 OpenAI API 类型，详见[配置](configuration.md)。

## 思考控制不生效

检查 reasoning 和 thinkingLevelMap。Chat Completions 使用 compat.thinkingFormat，未配置时由 SDK 根据服务商和地址选择。Responses 使用原生 reasoning。

chat-template 的 off 通过 thinking.enabled 传递 false，未映射 off 的 thinking.effort 会省略。确认模板包含服务端识别的开关参数。

## 上游拒绝请求

检查 API 类型、认证、compat、采样参数、extraBody 和 dropParams。输出上限只在模型定义或覆盖显式设置 maxTokens 时发送。

无认证服务可使用其允许的占位密钥。EMPTY 也会作为普通密钥发送。

## 候选获取失败

候选请求使用当前会话已加载的地址和认证。首次添加服务或修改连接信息后先保存并重载，再检查 `GET <baseUrl>/models`。

响应需包含 data 数组，ID 非空且唯一。查询超时为 30 秒，独立于流式请求的 timeoutMs。获取失败时可手动填写 ID。

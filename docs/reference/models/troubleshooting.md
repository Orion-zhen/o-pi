# 模型排障

## 模型没有显示

1. 检查 `models.json` 路径、配置错误与认证。
2. 确认 models 为对象数组，每项包含 id，并配置 API 类型。
3. GUI 候选需先添加到配置。
4. 保存后重载当前会话。

API、连接信息和继承规则遵循 Pi SDK，详见[配置](configuration.md)。旧 `timeoutMs`、`maxRetries` 扩展字段需删除。

## 思考控制不生效

检查 reasoning 和 thinkingLevelMap。Chat Completions 使用 compat.thinkingFormat，未配置时由 SDK 根据服务商和地址选择。Responses 使用原生 reasoning。

chat-template 的 off 通过 thinking.enabled 传递 false，未映射 off 的 thinking.effort 会省略。确认模板包含服务端识别的开关参数。

## 上游拒绝请求

检查 API 类型、认证、compat、采样参数、extraBody 和 dropParams。Chat Completions 与 Responses 的会话输出上限仅在显式设置 maxTokens 时发送。其他协议遵循 SDK 原生预算。

无认证服务可使用其允许的占位密钥。EMPTY 也会作为普通密钥发送。

## 候选获取失败

候选请求使用当前会话已加载的地址和认证。首次添加服务或修改连接信息后先保存并重载，再检查对应协议的[列表接口](README.md#自定义服务)。Google 地址需包含版本路径。

OpenAI 与 Anthropic 响应使用 `data` 数组，Google 使用 `models` 数组。模型 ID 必须非空且唯一。查询总超时为 8 秒，分页查询共用该预算。没有通用列表接口的协议只读取当前 SDK 目录，不触发刷新，也不能据此确认服务连接。获取失败时可手动填写 ID。

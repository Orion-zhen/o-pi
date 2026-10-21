# 模型排障

## 模型没有显示

1. 检查 `models.json` 路径、配置错误与认证。
2. 确认 models 为对象数组，每项包含 id，并配置 API 类型。
3. GUI 候选需先添加到配置。
4. 保存后重载当前会话。

启用扩展请求改写的服务需要 baseUrl 和 OpenAI API 类型，详见[配置](configuration.md)。

## 思考或路由错误

检查 reasoning、thinkingLevelMap 和 thinkingPreset。auto 使用 SDK 默认，none 清理思考控制字段，model-suffix 按当前等级选择模型 ID。

后缀模式只注册基础模型。GUI 可从候选补全映射，已有配置优先，重新推导时点击“恢复默认映射”。

## 上游拒绝请求

检查 API 类型、认证、compat、采样参数、extraBody 和 dropParams。输出上限只在模型定义或覆盖显式设置 maxTokens 时发送。

无认证服务可使用其允许的占位密钥。EMPTY 也会作为普通密钥发送。

## 候选获取失败

候选请求使用当前会话已加载的地址和认证。首次添加服务或修改连接信息后先保存并重载，再检查 `GET <baseUrl>/models`。

响应需包含 data 数组，ID 非空且唯一。查询超时为 30 秒，独立于流式请求的 timeoutMs。获取失败时可手动填写 ID。

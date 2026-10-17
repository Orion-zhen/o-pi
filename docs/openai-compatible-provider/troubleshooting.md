# 故障排查

## 模型没有显示

1. 确认使用 `~/.pi/agent/models.json`，旧的 `models.jsonc` 不再读取。
2. 检查原生配置错误和 API key，或通过 `/login` 保存凭证。
3. `models` 必须是对象数组，包含 `id`，并在 provider 或模型层配置 API。
4. GUI 候选列表不自动启用模型，需要选择添加或手动填写 ID。
5. 保存后执行 `/reload` 或重启。扩展 provider 必须声明 `baseUrl` 和 OpenAI `api`。

## 思考或模型路由不正确

- 显式声明 `reasoning: true` 和所需 `thinkingLevelMap`。
- 两种 API 均使用 `thinkingPreset`。`auto` 使用 SDK 默认行为，`none` 不发送思考控制参数。
- 未配置预设时不再默认删除 reasoning，也不注入保守 compat。
- `model-suffix` 只注册基础模型。GUI 获取候选后按真实后缀补全等级，保存并重载后生效。已有手动配置优先，需重新解析时点击「恢复默认映射」。

## 上游拒绝请求

确认 `api` 类型，随后按服务实际差异配置 `compat`。检查原生默认输出上限、`samplingParams`、`extraBody` 和 `dropParams`。

`EMPTY` 不再禁用认证头。无认证服务需要接受占位密钥。纯请求头认证也需要配置原生可用凭证或占位密钥。

## GUI 候选列表获取失败

候选查询使用当前会话已加载的地址和认证，添加或修改模型后无需重载即可继续查询。首次添加服务或需要应用新的地址、认证时，先保存并重载。查询失败时检查认证与 `GET <baseUrl>/models`。响应必须包含 `data` 数组，ID 非空且唯一。超时为 30 秒，不使用流式请求的 `timeoutMs`。

列表不可用时可手动填写模型 ID，已配置模型不受影响。

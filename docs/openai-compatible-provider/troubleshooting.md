# 故障排查

## 模型没有显示

1. 确认使用 `~/.pi/agent/models.json`，旧的 `models.jsonc` 不再读取。
2. 检查原生配置错误和 API key，或通过 `/login` 保存凭证。
3. 静态 `models` 必须是对象数组，包含 `id`，并在 provider 或模型层配置 API。
4. 自动发现需要 `discoverModels: true`，并在联网模式刷新目录。扩展 provider 必须声明 `baseUrl` 和 OpenAI `api`。
5. 修改扩展选项后执行 `/reload` 或重启。

## 思考或模型路由不正确

- 静态模型显式声明 `reasoning: true` 和所需 `thinkingLevelMap`。
- Chat Completions 使用 `compat.thinkingFormat`，Responses 非标准编码使用 `thinkingPreset`。
- 未配置预设时不再默认删除 reasoning，也不注入保守 compat。
- `model-suffix` 自动折叠发现目录的变体。使用 `modelOverrides` 调整发现模型，避免静态 `models` 覆盖推导出的映射。
- 静态路由只注册基础模型，并显式配置等级映射。

## 上游拒绝请求

确认 `api` 类型，随后按服务实际差异配置 `compat`。检查原生默认输出上限、`samplingParams`、`extraBody` 和 `dropParams`。

`EMPTY` 不再禁用认证头。无认证服务需要接受占位密钥。纯请求头认证也需要配置原生可用凭证或占位密钥。

## 发现失败

检查 `GET <baseUrl>/models` 或 `modelsEndpoint`。响应必须包含非空 `data` 数组，ID 非空且唯一。超时固定为 30 秒，不使用流式请求的 `timeoutMs`。

错误包含 provider 和 HTTP 状态，响应正文最多显示 500 字符。不要公开包含敏感响应正文的日志。刷新失败时 SDK 保留已发布目录。

迁移后旧缓存仍可能存在，联网刷新一次以替换旧目录。发现请求头或扩展字段变更后需要重新加载扩展。

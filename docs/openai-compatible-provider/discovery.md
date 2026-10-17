# 自动发现

只有 `discoverModels: true` 才会请求模型目录。省略 `models` 不再隐式开启联网。静态服务不需要实现 `/models`。

请求地址默认为 `GET <baseUrl>/models`。`modelsEndpoint` 可以是相对路径或完整 URL。目录请求使用 SDK 刷新上下文中的有效 base URL、API key 和取消信号，另有独立的 30 秒超时。

响应必须是 `{ "data": [...] }`，数组非空，每个对象必须有非空且唯一的 `id`。扩展仅读取：

- `id`
- 有效的 `context_length`
- `architecture.input_modalities` 中的 `image`

其他模型能力由原生 `models` 或 `modelOverrides` 提供。`model-suffix` 在构建发现目录时折叠已知等级变体。

## 原生生命周期

扩展通过 `createProvider({ fetchModels })` 提供发现结果，不覆盖 `getModels`、`getAllModels` 或 `refreshModels`。

SDK 负责离线恢复、静态基线和动态目录合并、取消、并发发布及 `ModelsStore` 持久化。刷新或持久化失败时保留已发布目录。`getModels` 与 `getAllModels` 使用同一份状态，聊天入口过滤非聊天模型。

缓存只保存发现目录，不混入手写模型覆盖、密钥或解析后的请求头。当前 `models.json` 由 SDK 在目录外层应用：

- `models` 是完整定义，会添加或替换同名模型。
- `modelOverrides` 修改已存在的模型，适合补充发现结果，并在离线恢复时继续生效。

旧缓存可能包含过去的配置元数据，迁移后建议联网刷新一次。变更发现端点、目录请求头或扩展选项后执行 `/reload` 或重启。普通请求认证与模型字段仍按 SDK 原生刷新流程更新。

目录认证限制见 [认证和请求头](authentication.md#目录请求)。

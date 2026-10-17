# 配置加载

扩展与 SDK 共用 `~/.pi/agent/models.json`。修改扩展字段后执行 `/reload` 或重启。旧的 `models.jsonc` 不再读取，也不会自动迁移。

GUI 可在「设置 → 模型服务」编辑 OpenAI 兼容服务。保存后使用主界面的「重载资源」或 `/reload`，重载只影响当前会话。服务的已保存配置与当前会话不一致时显示「待重载」，重新打开设置不会清除该状态。展开服务设置会使用当前会话已加载的地址和认证获取 `/models` 候选列表，可点击「重新获取」重试。「待重载」不阻止查询，可以连续添加、保存多个模型后统一重载。首次添加服务需保存并重载以初始化连接，修改地址或认证后也在重载时切换到新连接。

点击「添加模型」，在同一输入框中填写 ID 或选择候选。输入会按 ID 筛选候选，不区分大小写。选择后点击「添加」，也可直接添加未匹配到候选的 ID，新增模型写入 `models`。候选列表不自动注册模型。`model-suffix` 模式按真实 ID 合并后缀变体，并为已选模型补全尚未配置的思考能力和等级映射，保存并重载后生效。其他模式保留原始候选。获取失败不影响手动添加。未提供表单的字段通过 JSON 编辑，表单修改保留注释和其他提供方配置。

SDK 负责普通 provider、认证、原生字段及 `modelOverrides` 的组合。以下配置需要注册完整扩展 provider：

- provider：`thinkingPreset`、`timeoutMs`、`maxRetries`、`dropParams`、`extraBody`。
- `models` 或 `modelOverrides`：`thinkingPreset`、`dropParams`。

`defaultThinkingLevel` 独立处理模型选择事件，不替换 provider，也不限制 API 类型。Chat Completions 和 Responses 会话在发送请求前移除未显式配置的输出上限，此行为同样不替换 provider。

字段直接平铺。需要注册的 provider 必须声明 `baseUrl` 和 `api`，`api` 只接受 `openai-completions` 或 `openai-responses`。

加载、GUI 保存和表单共用 SDK 原生 schema 与扩展校验。harness 统一解析模型继承值、兼容默认值、思考映射和有效覆盖，并提供保留注释的 JSONC 编辑与候选补全。纯配置函数直接在浏览器执行，候选网络请求通过 GUI host 调用 harness，使用当前会话的 SDK 认证。UI 负责输入、草稿和请求生命周期，不另设协议或等级限制。

默认值比较只影响表单的修改判断和重置提示，不清洗原始配置。源码编辑仍保留纯格式和注释修改。未开启思考能力时也可预先编辑映射。只有 `modelOverrides` 条目的 ID 仍可添加到 `models`，原有覆盖继续生效。

扩展只提取自己的选项和注册所需的模型 ID/API，原生模型字段由 SDK 应用。扩展配置错误包含文件路径和字段位置，不打印完整配置或密钥。

配置可能包含密钥，建议限制权限：

```bash
chmod 600 ~/.pi/agent/models.json
```

扩展只读取文件并检查权限，不写入、生成或同步配置。

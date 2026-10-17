# 配置加载

扩展与 SDK 共用 `~/.pi/agent/models.json`。修改扩展字段后执行 `/reload` 或重启。旧的 `models.jsonc` 不再读取，也不会自动迁移。

GUI 可在「设置 → 模型服务」编辑 OpenAI 兼容服务。保存后使用主界面的「重载资源」或 `/reload`，重载只影响当前会话。服务的已保存配置与当前会话不一致时显示「待重载」，重新打开设置不会清除该状态。启用自动发现且已配置认证的服务，重载后可点击「刷新模型」。

手动模型写入 `models`，发现模型的修改写入 `modelOverrides`。未提供表单的字段通过 JSON 编辑，表单修改保留注释和其他提供方配置。

SDK 负责普通 provider、认证、原生字段及 `modelOverrides` 的组合。以下配置需要注册完整扩展 provider：

- `discoverModels: true`。
- provider：`thinkingPreset`、`timeoutMs`、`maxRetries`、`dropParams`、`extraBody`。
- `models` 或 `modelOverrides`：`thinkingPreset`、`dropParams`。

`modelsEndpoint` 要求启用发现。仅设置 `discoverModels: false` 不触发注册。`defaultThinkingLevel` 独立处理模型选择事件，不替换 provider，也不限制 API 类型。

字段直接平铺。需要注册的 provider 必须声明 `baseUrl` 和 `api`，`api` 只接受 `openai-completions` 或 `openai-responses`。

加载、GUI 保存和表单共用 SDK 原生 schema 与扩展校验。扩展只提取自己的选项、模型 ID/API 和目录请求所需字段，原生模型字段由 SDK 应用。扩展配置错误包含文件路径和字段位置，不打印完整配置或密钥。

配置可能包含密钥，建议限制权限：

```bash
chmod 600 ~/.pi/agent/models.json
```

扩展只读取文件并检查权限，不写入、生成或同步配置。

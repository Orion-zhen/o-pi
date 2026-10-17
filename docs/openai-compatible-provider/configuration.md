# 配置加载

扩展与 SDK 共用 `~/.pi/agent/models.json`。修改扩展字段后执行 `/reload` 或重启。旧的 `models.jsonc` 不再读取，也不会自动迁移。

SDK 负责普通 provider、认证、原生字段及 `modelOverrides` 的组合。以下配置需要注册完整扩展 provider：

- `discoverModels: true`。
- provider：`thinkingPreset`、`timeoutMs`、`maxRetries`、`dropParams`、`extraBody`。
- `models` 或 `modelOverrides`：`thinkingPreset`、`dropParams`。

`modelsEndpoint` 要求启用发现。仅设置 `discoverModels: false` 不触发注册。`defaultThinkingLevel` 独立处理模型选择事件，不替换 provider，也不限制 API 类型。

字段直接平铺。需要注册的 provider 必须声明 `baseUrl` 和 `api`，`api` 只接受 `openai-completions` 或 `openai-responses`。

原生模型字段由 SDK 校验并应用。扩展只读取自己的选项、模型 ID/API 和目录请求所需字段，不再复制原生模型 schema。扩展配置错误包含文件路径和字段位置，不打印完整配置或密钥。

配置可能包含密钥，建议限制权限：

```bash
chmod 600 ~/.pi/agent/models.json
```

扩展只读取文件并检查权限，不写入、生成或同步配置。

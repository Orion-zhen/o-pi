# 故障排查

## Provider 没有注册

检查：

1. 文件路径是否为 `~/.pi/agent/models.jsonc`；
2. JSONC 是否可解析；
3. 根对象是否只有 `providers`；
4. provider 是否包含非空 `baseUrl`；
5. `api` 和 `thinkingPreset` 是否使用受支持的值。

文件不存在时扩展会安静地不注册 provider。

## 配置校验失败

错误会包含文件路径和配置路径，例如：

```text
Invalid ~/.pi/agent/models.jsonc:
providers.gateway.models[0].id is required
```

常见原因：

- 使用了 `base_url`、`api_key`、`top_p` 等旧字段；
- model 缺少 `id`；
- 同一 provider 中 model id 重复；
- 使用了 `api: "chat"` 或 `api: "responses"`；
- `reasoning: false` 同时配置 thinking level；
- `extraBody` 包含 `model`、`messages`、`input`、`tools` 或 `stream`；
- `thinkingLevelMap` 或 default level 不符合 Pi level。

## 认证失败

按以下顺序检查：

1. 环境变量是否存在；
2. provider id 对应的默认变量名是否正确；
3. keyless 服务是否使用 `apiKey: "EMPTY"`；
4. 自定义 auth header 是否拼写正确；
5. command 是否能在 10 秒内返回非空 stdout；
6. 调用方 credential 是否覆盖了预期配置。

默认变量名格式：

```text
PI_MODELS_JSONC_<PROVIDER_ID>_API_KEY
```

不要在错误日志中粘贴真实 API key。

## 模型没有显示

先运行：

```bash
pi --list-models <provider-id> --offline
```

然后检查：

- 手写 model 是否有 `id`；
- model id 是否重复；
- 是否误用了另一个 provider id；
- ModelsStore 是否包含与当前 endpoint/API/compat 匹配的缓存；
- 在线 `/model` 是否显示刷新失败。

`--offline` 不请求网络，只能看到手写模型和有效缓存。

## 自动发现失败

确认：

- `<baseUrl>/models` 或 `modelsEndpoint` 可访问；
- endpoint 返回数组、`data` 数组或 `models` 数组；
- 每个条目包含 `id` 或 `model`；
- key/header 被 endpoint 接受；
- endpoint 没有返回空数组。

当前 models endpoint 使用独立的 30 秒 timeout；provider 的 `timeoutMs` 主要影响模型 stream，不改变自动发现 timeout。

## 上游拒绝 payload

先确认：

1. `api` 是 `openai-completions` 还是 `openai-responses`；
2. `compat.maxTokensField` 是否正确；
3. thinking preset 是否匹配服务实际格式；
4. 不支持的字段是否加入 `dropParams`；
5. `extraBody` 是否只包含非核心字段；
6. model `defaults.maxTokens` 是否超过服务允许的最大值。

对于 Responses 服务，非 `openai` preset 会清理 Pi 原有 thinking 字段后重新编码。

## Thinking level 不可用

- `xhigh`/`max` 需要显式 `thinkingLevelMap`；
- map 的 key 必须是 Pi 支持的 level；
- map 值为 `null` 会隐藏对应 level；
- `defaultThinkingLevel` 必须在 map 允许的 level 中；
- `reasoning: false` 不能和 default level/map 同时使用。

## 配置权限 warning

执行：

```bash
chmod 600 ~/.pi/agent/models.jsonc
```

warning 不会自动改写文件，也不会阻止 provider 注册。

## 仍然无法定位问题

保留以下非敏感信息：

- provider id；
- API 类型；
- model id；
- endpoint 的 host 和 path；
- 脱敏后的错误消息；
- 是否使用 `EMPTY`、环境变量或 command。

不要提供 API key、认证 header、完整配置文件或 command secret。完整字段行为见 [schema.md](schema.md)，发现流程见 [discovery.md](discovery.md)。

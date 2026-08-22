# 故障排查

## 提供方没有注册

按以下顺序检查：

1. 配置文件路径是否为 `~/.pi/agent/models.jsonc`。
2. 文件是否符合 JSONC 语法。
3. 根对象是否只包含 `providers`。
4. 提供方是否包含非空的 `baseUrl`。
5. `api` 和 `thinkingPreset` 是否使用受支持的值。

配置文件不存在时，扩展不会注册提供方，也不会报错。

## 配置校验失败

错误会包含文件路径和配置路径，例如：

```text
Invalid ~/.pi/agent/models.jsonc:
providers.gateway.models[0].id is required
```

常见原因包括：

- 在提供方或模型对象中使用 `base_url`、`api_key` 等旧字段
- 模型缺少 `id`
- 同一提供方内的模型 ID 重复
- 使用 `api: "chat"` 或 `api: "responses"`
- 同时配置 `reasoning: false` 与 `defaultThinkingLevel` 或 `thinkingLevelMap`
- 提供方的 `extraBody` 包含 `model`、`messages`、`input`、`tools` 或 `stream`
- `thinkingLevelMap` 或默认级别包含 Pi 不支持的思考级别

## 认证失败

按以下顺序检查：

1. 环境变量是否存在且非空。
2. 提供方 ID 对应的默认环境变量名是否正确。
3. 无认证服务是否设置 `apiKey: "EMPTY"`。
4. 自定义认证请求头的名称和值是否正确。
5. 命令是否能在 10 秒内返回非空的标准输出。
6. Pi 在运行时提供的登录凭证是否覆盖了配置中的凭证。

默认环境变量名格式如下：

```text
PI_MODELS_JSONC_<PROVIDER_ID>_API_KEY
```

不要在错误日志中粘贴真实 API 密钥。

## 模型没有显示

先运行：

```bash
pi --list-models <provider-id> --offline
```

然后检查：

- 手写模型是否包含非空的 `id`
- 模型 ID 是否重复
- 使用的提供方 ID 是否正确
- `ModelsStore` 中是否有来源与当前目录端点、API 类型、思考配置、兼容选项和手写模型配置匹配的缓存
- 在联网模式下打开 `/model` 时是否出现刷新错误

`--offline` 不会发送网络请求，只显示手写模型和来源匹配的缓存。

## 自动发现失败

确认以下条件：

- `<baseUrl>/models` 或 `modelsEndpoint` 可以访问。
- 端点返回数组、`data` 数组或 `models` 数组。
- 每个条目是非空字符串，或包含 `id` 或 `model` 的对象。
- 端点接受当前密钥和请求头。
- 端点返回至少一个模型。

模型目录请求使用独立的 30 秒超时。提供方的 `timeoutMs` 控制模型流式请求，不会改变自动发现的超时时间。

## 上游拒绝请求体

按以下顺序检查：

1. `api` 是否为正确的 `openai-completions` 或 `openai-responses`。
2. `compat.maxTokensField` 是否符合上游要求。
3. `thinkingPreset` 是否符合上游的思考字段格式。
4. 上游不支持的非核心字段是否已加入 `dropParams`。
5. 提供方的 `extraBody` 是否只包含非核心字段。
6. 模型顶层的 `maxTokens` 是否超过上游限制。
7. `samplingParams` 是否错误包含令牌上限或核心请求字段。

对于 Responses API，非 `openai` 预设会删除 Pi 已生成的思考字段，再按预设重新编码。

## 思考级别不可用

- `xhigh` 和 `max` 需要在 `thinkingLevelMap` 中显式配置映射。
- 映射键必须是 Pi 支持的思考级别。
- 映射值为 `null` 时，Pi 隐藏对应级别。
- `defaultThinkingLevel` 必须是当前映射支持的级别。
- `reasoning: false` 不能与 `defaultThinkingLevel` 或 `thinkingLevelMap` 同时使用。

## 配置权限警告

运行：

```bash
chmod 600 ~/.pi/agent/models.jsonc
```

警告不会阻止提供方注册。扩展也不会自动修改文件权限。

## 仍然无法定位问题

保留以下非敏感信息：

- 提供方 ID
- API 类型
- 模型 ID
- 端点的主机和路径
- 脱敏后的错误消息
- `apiKey` 使用字面量、`EMPTY`、环境变量引用还是命令

不要提供 API 密钥、认证请求头、完整配置文件或命令中的秘密值。字段说明见[提供方和模型配置模式](schema.md)。模型发现流程见[自动发现](discovery.md)。

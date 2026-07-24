# 自动发现和 ModelsStore

## 启用方式

以下配置会使用 models endpoint：

```jsonc
{
  "models": "auto"
}
```

省略 `models` 时也使用默认 endpoint。手写数组会先注册手写模型；刷新时仍可以请求 endpoint 补充远端 metadata。

## Endpoint URL

默认请求：

```text
GET <baseUrl>/models
```

可以覆盖：

```jsonc
{
  "modelsEndpoint": "v1/models"
}
```

也可以提供完整 URL。相对路径按 `baseUrl` 解析。

自动发现使用独立的 30 秒请求 timeout。provider 的 `timeoutMs` 进入模型 stream runtime，不替换当前实现中的 models endpoint timeout。

## 认证和请求

请求至少包含：

```text
Accept: application/json
```

认证使用当前有效的 Pi credential、provider `apiKey` 和 provider headers。`EMPTY` provider 不自动发送 Authorization。完整解析规则见 [authentication.md](authentication.md)。

请求支持取消；取消或 timeout 后会清理 timer 和 abort listener。

## 支持的响应

接受以下 JSON 形状：

```jsonc
[{ "id": "model-id" }]
```

```jsonc
{ "data": [{ "id": "model-id" }] }
```

```jsonc
{ "models": [{ "id": "model-id" }] }
```

每个模型可以是字符串或对象。对象至少需要 `id` 或 `model`。扩展会读取常见 metadata：

- `id` / `model`；
- `name` / `display_name`；
- `context_length`、`context_window` 等上下文字段；
- `max_output_tokens`、`max_completion_tokens`；
- `input_modalities`、`architecture.input_modalities` 等 image 能力。

重复 id 只保留第一次出现的模型。空目录、无效 JSON、缺失 id 和不支持的响应结构都会报错。

## 手写和远端模型合并

手写模型优先：

```text
手写模型顺序保持不变
→ endpoint metadata 补齐缺失字段
→ 手写字段覆盖同名远端字段
→ 远端独有模型追加到末尾
```

例如：

```jsonc
{
  "models": [
    { "id": "manual", "name": "My name" },
    "manual-only"
  ]
}
```

endpoint 返回的 `manual` 可以补充 context 和 image 能力，但不会覆盖手写的 `name`。

## ModelsStore

Pi 会把刷新后的模型目录写入 ModelsStore。缓存条目包含：

- 合并后的模型 metadata；
- `baseUrl`；
- endpoint、API、thinking 和 compat source hash；
- `checkedAt`。

不会写入 API key 或认证 header。扩展只恢复 source hash 与当前 provider 配置匹配的缓存模型，避免旧 endpoint 或旧 compat 污染当前目录。

## 离线行为

`--offline` 或 Pi 的离线 refresh：

- 先恢复有效的 ModelsStore；
- 不请求网络；
- 没有缓存时保留手写模型；
- 不会因网络失败清空已有动态目录。

在线刷新会在离线恢复完成后继续发起网络请求。并发 refresh 共享进行中的 Promise；如果已有离线恢复，后续允许网络的调用会等待恢复后继续。

## 错误

HTTP 非 2xx、响应 body 无法读取、JSON 无效、响应结构无效和 endpoint 返回空模型都会失败。错误包含 provider 和状态信息，并限制响应 body 长度；认证 header 不会出现在错误中。

手写或已恢复的旧目录不会因一次刷新失败立即丢失。需要完全重新获取时，可清除 ModelsStore 后重新打开 `/model`。

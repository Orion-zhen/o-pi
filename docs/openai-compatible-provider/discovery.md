# 自动发现和 `ModelsStore`

## 配置方式

以下配置不包含手写模型，只使用模型目录端点：

```jsonc
{
  "models": "auto"
}
```

省略 `models` 时，行为相同。配置模型数组时，扩展先注册手写模型。联网刷新仍会请求模型目录端点，并用远端元数据补充模型目录。

## 端点 URL

默认请求为：

```text
GET <baseUrl>/models
```

可以通过相对路径覆盖默认值：

```jsonc
{
  "modelsEndpoint": "models"
}
```

`modelsEndpoint` 也可以是完整 URL。相对路径以 `baseUrl` 为基准解析。

自动发现使用独立的 30 秒超时。提供方的 `timeoutMs` 控制模型流式请求，不会改变模型目录请求的超时时间。

## 认证和请求头

请求至少包含：

```text
Accept: application/json
```

模型目录请求使用 Pi 当前解析出的提供方凭证和 `headers`。如果 `apiKey` 为 `EMPTY`，扩展不会自动发送 `Authorization`。完整规则见[认证和敏感配置](authentication.md)。

请求支持取消。取消或超时后，扩展会清理计时器和中止事件监听器。

## 支持的响应结构

端点可以返回以下任一 JSON 结构：

```jsonc
[{ "id": "model-id" }]
```

```jsonc
{ "data": [{ "id": "model-id" }] }
```

```jsonc
{ "models": [{ "id": "model-id" }] }
```

每个模型条目可以是非空字符串或对象。对象必须包含非空的 `id` 或 `model`。扩展读取以下常见元数据：

- `id` 或 `model`
- `display_name` 或 `name`
- `context_window`、`context_length`、`max_context_length`、`max_model_len` 或 `max_sequence_length`
- `max_output_tokens` 或 `max_completion_tokens`，包括 `top_provider` 中的同名字段
- `input_modalities`、`architecture.input_modalities`、`modalities.input` 或 `modalities` 中的图片输入能力

端点返回重复模型 ID 时，扩展只保留第一个条目。空模型目录、无效 JSON、缺失模型 ID 或不支持的响应结构都会导致刷新失败。

## 合并手写模型和远端模型

扩展按以下规则合并模型：

```text
保留手写模型顺序
→ 用远端元数据补充手写模型缺少的字段
→ 保留手写模型已有的字段值
→ 把远端独有模型追加到末尾
```

例如：

```jsonc
{
  "models": [
    { "id": "manual", "name": "手写名称" },
    "manual-only"
  ]
}
```

如果端点也返回 `manual`，远端数据可以补充上下文窗口和图片输入能力，但不会覆盖手写配置中的 `name`。

## `ModelsStore`

Pi 会把刷新后的模型目录写入 `ModelsStore`。缓存条目包含：

- 合并后的模型元数据
- `baseUrl`
- 根据目录端点、API 类型、思考预设、兼容选项和手写模型配置生成的来源哈希
- `checkedAt`

缓存不包含 API 密钥或认证请求头。扩展只恢复来源哈希与当前提供方配置匹配的模型，避免旧端点或旧配置中的模型进入当前模型目录。

## 离线行为

离线刷新或使用 `--offline` 时：

- 扩展先恢复来源匹配的 `ModelsStore` 缓存。
- 扩展不发送网络请求。
- 没有有效缓存时，扩展保留手写模型。
- 网络刷新失败不会清空已有目录。

联网刷新会在恢复缓存后请求模型目录端点。

## 错误处理

以下情况会导致刷新失败：

- HTTP 状态不是 2xx
- 响应体无法读取
- 响应体不是有效 JSON
- JSON 结构不受支持
- 端点未返回任何模型

所有刷新错误都会指出提供方。模型目录端点返回非 2xx 状态时，错误还会包含 HTTP 状态，并最多截取响应正文的前 500 个字符。扩展不会把请求中的认证请求头写入错误。

一次刷新失败不会立即删除手写模型或已恢复的缓存模型。如需重新获取完整的模型目录，请清除 `ModelsStore`，然后再次打开 `/model`。

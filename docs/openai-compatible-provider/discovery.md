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

端点必须返回包含 `data` 数组的对象：

```jsonc
{
  "data": [
    {
      "id": "model-id",
      "context_length": 131072,
      "architecture": {
        "input_modalities": ["text", "image"]
      }
    }
  ]
}
```

`data` 中的每个条目必须是对象，并包含非空的 `id`。扩展只读取以下字段：

- `id`
- `context_length`
- `architecture.input_modalities` 中的 `image` 输入能力

未声明的元数据不会进入模型目录。根数组、`models` 数组、字符串条目、字段别名、空目录、重复 ID 和缺失 ID 都会导致刷新失败。

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

如果端点也返回 `manual`，远端数据可以补充上下文窗口和图片输入能力，但不会覆盖手写配置中的字段。远端独有模型的显示名称默认为 `id`，最大输出令牌数使用扩展默认值。

## `ModelsStore`

模型目录由 Pi 原生 `createProvider` 生命周期管理。Pi 按提供方 ID 保存刷新后的模型 overlay，缓存条目包含：

- 合并后的模型元数据
- `baseUrl` 和 API 类型
- `checkedAt` 等 Pi 原生刷新状态

缓存不包含 API 密钥、认证请求头或扩展内部标记。缓存恢复不比较当前配置；因此配置改变后，联网刷新前可能暂时显示旧的缓存 overlay。

## 离线行为

离线刷新或使用 `--offline` 时：

- Pi 先恢复该提供方的 `ModelsStore` 缓存 overlay。
- 扩展不发送网络请求。
- 没有缓存时，保留手写 baseline 模型。
- 网络刷新失败不会清空已有目录。

联网刷新会在缓存恢复后请求模型目录端点。请求成功并发布后，Pi 原生生命周期替换旧 overlay；发布失败或请求失败则保留旧目录。

## 错误处理

以下情况会导致刷新失败：

- HTTP 状态不是 2xx
- 响应体无法读取
- 响应体不是有效 JSON
- 根对象不包含 `data` 数组
- `data` 条目不是对象、缺少非空 `id` 或包含重复 ID
- 端点未返回任何模型

所有刷新错误都会指出提供方。模型目录端点返回非 2xx 状态时，错误还会包含 HTTP 状态，并最多截取响应正文的前 500 个字符。扩展不会把请求中的认证请求头写入错误。

一次刷新失败不会立即删除手写模型或已恢复的缓存模型。需要清除目录时，按 Pi 的 `ModelsStore` 管理方式删除对应提供方缓存，然后再次刷新。

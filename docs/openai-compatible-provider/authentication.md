# 认证和请求头

请求认证完全使用 SDK 原生 `models.json`、`auth.json` 和运行时凭证。运行时密钥优先于存储凭证，存储凭证优先于配置密钥。已有 OAuth 凭证不会被静默替换为 API key。

`apiKey` 和请求头支持 SDK 的值语法：

| 写法 | 行为 |
| --- | --- |
| `"sk-..."` | 字面量 |
| `"$NAME"`、`"${NAME}"` | 环境变量插值 |
| `"!command"` | 请求时执行命令并读取输出，不缓存结果 |
| `"$$"`、`"$!"` | 字面量 `$`、`!` |

通过 `/login` 保存密钥也可使用服务。自定义 provider 没有自动生成的环境变量名，需要显式配置变量引用。

无认证服务使用服务允许的占位密钥，如 `"apiKey": "local"`。`EMPTY` 是普通字符串，会发送 `Bearer EMPTY`。自定义认证头不隐式禁用 Bearer，`Authorization` 本身可覆盖默认 Bearer。只有自定义请求头的服务也需要原生可用凭证或占位密钥。

普通请求的 provider、模型和调用方请求头由 SDK 处理。调用方可以使用值为 `null` 的请求头移除对应字段。

## GUI 候选列表

GUI 通过 SDK `getAuth` 解析当前会话中的服务认证和 provider 级请求头，再请求 `GET <baseUrl>/models`。候选请求不使用模型级请求头，也不保存密钥、请求头或模型目录缓存。

已保存配置与会话不一致时先重载，避免将旧凭据发送到新地址。配置的 `Authorization` 优先，`authHeader: true` 由 SDK 强制生成 Bearer。

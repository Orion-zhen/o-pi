# 认证和敏感配置

## API key 配置值

`apiKey` 和 `headers` 的值可以是字面量、环境变量引用或命令：

| 写法 | 含义 |
| --- | --- |
| `"sk-..."` | 字面量。 |
| `"$ENV"` | `$ENV` 的值。 |
| `"${ENV}"` | `${ENV}` 的值。 |
| `"!command"` | 执行 command，使用 trimmed stdout。 |
| `"EMPTY"` | 默认 keyless，不发送 Authorization。 |
| `"$$"` | 字面量 `$`。 |
| `"$!"` | 字面量 `!`。 |

模板可以混合字面量和多个环境变量，例如：

```jsonc
{
  "apiKey": "prefix-$ACCOUNT-$TOKEN"
}
```

环境变量缺失时，认证不可用并返回明确的变量名。command 失败或返回空 stdout 时同样不可用。

## 默认 key 环境变量

省略 `apiKey` 时，扩展根据 provider id 生成：

```text
PI_MODELS_JSONC_<PROVIDER_ID>_API_KEY
```

provider id 中的非字母数字字符会转换为 `_` 并大写。例如：

```text
provider id: lab-server
variable:    PI_MODELS_JSONC_LAB_SERVER_API_KEY
```

## `EMPTY` 和运行时 credential

```jsonc
{
  "apiKey": "EMPTY"
}
```

表示默认使用无认证服务。模型目录请求只发送 `Accept: application/json`，不会自动添加 Authorization。

如果 Pi 在运行时提供显式 credential，它可以覆盖配置的 keyless 状态并用于本次请求。`EMPTY` 不会把字符串 `EMPTY` 当作真正的 bearer token。

## Header 合并

provider header 和 model header 都在请求边界解析：

```jsonc
{
  "headers": {
    "X-Account": "$ACCOUNT",
    "User-Agent": "pi-openai-compatible/1.0"
  }
}
```

基本优先级是：

```text
provider 配置
→ model 配置
→ 调用方显式 header
```

header 名称按大小写不敏感方式比较。调用方显式设置的 header 不应被 provider/model 配置覆盖。

认证 header 可以直接放在 `headers` 中；如果已经存在 Authorization 或 `CF-AIG-Authorization`，扩展不会再自动添加 bearer Authorization。

## 命令配置的边界

- auth check 只检查命令配置是否可用，不执行命令。
- 真正 resolve 或发起请求时才执行命令。
- 每个命令结果在进程内缓存。
- 命令执行 timeout 为 10 秒。
- stdout 会 trim；stderr 不作为认证值。
- 命令原文和结果不会写入 ModelsStore。

不要把不可信用户输入拼接进 command 配置。

## 模型发现认证

models endpoint 使用当前有效的 credential 和 provider header。在线刷新时，Pi 已解析的 credential 优先；没有显式 credential 时才使用 provider 配置。

自动发现错误会保留 provider、HTTP 状态和最多 500 个字符的响应片段，但不会把 Authorization 或 API key 放入错误消息。

## 持久化和脱敏

Pi ModelsStore 可能保存：

- 模型元数据；
- `baseUrl`；
- API、compat 和 endpoint source hash。

不会保存 API key 或认证 header。诊断显示会将 key 脱敏为 `<literal:redacted>`、`<env:NAME>`、`<command:redacted>` 或 `<empty-placeholder>`。

## 文件权限

配置可能包含 API key，建议：

```bash
chmod 600 ~/.pi/agent/models.jsonc
```

Unix 上 group/others 可读写时扩展显示 warning。权限 warning 不会自动修改文件。

# 配置加载和校验

## 配置文件

扩展默认读取：

```text
~/.pi/agent/models.jsonc
```

实际路径由 Pi agent directory 决定。文件不存在时扩展不注册任何 provider；不会读取或修改 Pi 原生 `models.json`。

建议限制权限：

```bash
chmod 600 ~/.pi/agent/models.jsonc
```

Unix 上如果 group/others 仍可读写，扩展会显示 warning；Windows 不执行这项检查。

## 根结构

根对象只允许 `providers`：

```jsonc
{
  "providers": {
    "provider-id": {
      "baseUrl": "https://example.com/v1",
      "models": ["model-id"]
    }
  }
}
```

provider key 是 Pi provider id，必须非空。每个 provider 必须有非空 `baseUrl`。模型对象必须有非空 `id`，同一 provider 内不能重复。

JSONC 支持注释和 trailing comma，但仍必须是合法 JSONC。

## 配置层级

大多数字段按以下顺序解析：

```text
Pi 默认值
→ provider 配置
→ model 配置
→ 请求期 Pi/caller 值
```

适用规则：

- model 的 `api`、`baseUrl`、`thinkingPreset`、`compat` 等覆盖 provider 对应值。
- `dropParams` 按 provider 后 model 的顺序追加。
- `extraBody` 先合并 provider，再由 model 覆盖同名字段。
- provider 的 `timeoutMs` 和 `maxRetries`进入运行时模型配置。
- 采样默认值只允许放在 model 的 `defaults`。

## JSONC 校验

扩展在注册前执行 JSONC 解析和 schema 校验。错误包含文件路径和配置路径，例如：

```text
Invalid ~/.pi/agent/models.jsonc:
providers.gateway.models[0].id is required
```

以下情况会拒绝加载：

- 根对象包含未知字段；
- provider 缺少 `baseUrl`；
- model 缺少或重复 `id`；
- `api` 不是 `openai-completions` 或 `openai-responses`；
- `thinkingPreset` 不存在；
- `extraBody` 或 compat 结构不符合 schema；
- thinking level 与 `thinkingLevelMap` 不匹配；
- 扩展字段试图覆盖核心 payload 字段。

## Legacy 字段

当前配置使用 camelCase。旧 snake_case 字段不会静默转换，而会提示替代字段：

| 旧字段 | 新字段 |
| --- | --- |
| `display_name` | `name` |
| `base_url` | `baseUrl` |
| `api_key` | `apiKey` |
| `models_endpoint` | `modelsEndpoint` |
| `thinking` | `thinkingPreset` |
| `thinking_level` | `defaultThinkingLevel` |
| `thinking_level_map` | `thinkingLevelMap` |
| `top_p` | `topP` |
| `max_tokens` | `maxTokens` |

同样，旧的 `advanced` 容器应改为直接放 provider/model 字段。

## 相关配置

完整字段参考见 [Provider/Model schema](schema.md)。认证值、环境变量和命令解析见 [authentication.md](authentication.md)。

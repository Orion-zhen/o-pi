# 配置加载和校验

## 配置文件

扩展默认读取：

```text
~/.pi/agent/models.jsonc
```

实际路径取决于 Pi 的代理目录。文件不存在时，扩展不会注册任何提供方，也不会报错。扩展不会读取或修改 Pi 的 `models.json`。

配置文件可能包含 API 密钥，建议限制文件权限：

```bash
chmod 600 ~/.pi/agent/models.jsonc
```

在 Unix 系统上，如果组用户或其他用户具有该文件的任何权限，扩展会显示警告。Windows 不执行此项检查。

## 根对象

根对象必须包含 `providers`，且不能包含其他字段：

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

`providers` 的键是 Pi 提供方 ID，不能为空。每个提供方必须包含非空的 `baseUrl`。模型对象必须包含非空的 `id`。同一提供方内不能出现重复的模型 ID。

JSONC 支持注释和尾随逗号，但文件仍须符合 JSONC 语法。

## 配置层级

大多数字段按以下顺序解析：

```text
Pi 默认值
→ 提供方配置
→ 模型配置
→ 单次请求中的 Pi 或调用方参数
```

具体规则如下：

- 模型的 `api`、`baseUrl` 和 `thinkingPreset` 等字段覆盖提供方的同名字段。
- 模型配置会覆盖 `compat` 中的同名顶层字段。对象字段整体覆盖，不合并子字段。
- `dropParams` 按提供方列表、模型列表的顺序拼接。
- `extraBody` 只能配置在提供方对象中。
- 提供方的 `timeoutMs` 和 `maxRetries` 用于模型请求。
- 模型的 `samplingParams` 直接写入 Pi 模型。单次请求的同名参数优先。

## JSONC 校验

扩展在注册提供方前解析 JSONC 并校验配置模式。错误包含文件路径和配置路径，例如：

```text
Invalid ~/.pi/agent/models.jsonc:
providers.gateway.models[0].id is required
```

以下情况会导致加载失败：

- 根对象、提供方对象或模型对象包含未知字段
- 根对象缺少 `providers`
- 提供方缺少 `baseUrl`
- 模型缺少 `id`，或同一提供方内的 `id` 重复
- `api` 不是 `openai-completions` 或 `openai-responses`
- `thinkingPreset` 不是受支持的预设
- `compat` 不是对象
- 思考级别或 `thinkingLevelMap` 无效
- `reasoning: false` 与 `defaultThinkingLevel` 或 `thinkingLevelMap` 同时出现
- 提供方的 `extraBody` 试图覆盖核心请求字段，或提供方/模型的 `dropParams` 试图删除核心请求字段

`compat` 对象内的未知字段会保留并传给 Pi。加载器不会校验这些字段的名称和类型。

## 字段命名和未知字段

提供方字段和模型元数据使用驼峰命名。`samplingParams` 是例外，其中直接使用上游请求体字段名。扩展不会自动迁移旧字段。旧字段和其他未知字段由 schema 校验拒绝，错误不会提供定制迁移提示。

`samplingParams` 应使用 `top_p`、`top_k` 等上游字段名。扩展不会将这些字段名转换为驼峰命名。

## 相关文档

完整字段参考见[提供方和模型配置模式](schema.md)。认证值、环境变量和命令解析规则见[认证和敏感配置](authentication.md)。

# 模型配置与认证

扩展与 SDK 共用 `models.json`。GUI 保存后执行 `/reload` 或点击“重载资源”，应用到当前会话。

## 原生字段

provider 使用 `baseUrl`、`api`、`apiKey`、`headers`、`compat`、`models` 和 `modelOverrides`。`models` 是包含 ID 的对象数组。

模型常用字段：

| 字段 | 含义 |
| --- | --- |
| `id`、`name` | 模型标识与展示名称 |
| `reasoning` | 是否支持思考 |
| `thinkingLevelMap` | 等级可用性和提供方值 |
| `input`、`inputLimits` | 输入类型和图片、请求大小限制 |
| `contextWindow` | 上下文容量，SDK 默认 128000 |
| `maxTokens` | 请求输出上限，须大于 0 |
| `cost`、`promptCache` | 费用和缓存信息 |
| `samplingParams` | 采样参数 |
| `samplingParamsByThinkingLevel` | 按思考等级覆盖采样参数 |
| `headers`、`compat` | 请求头与兼容选项 |

`models` 添加或替换同名模型，`modelOverrides` 在组合后覆盖已知模型。SDK 先确定有效思考等级，再合并模型、等级和单次请求的采样参数。

对于配置文件中的服务，Chat Completions 和 Responses 仅在模型定义或覆盖显式设置 `maxTokens` 时发送输出上限。未设置时由服务端决定。独立标题和压缩请求继续使用各自预算。

图片进入历史时由 SDK 按 `inputLimits.images` 处理，切换模型保留已有历史。

## 扩展字段

字段与原生字段平铺：

| 字段 | 位置 | 含义 |
| --- | --- | --- |
| `thinkingPreset` | provider、model、modelOverrides | 思考传递方式 |
| `timeoutMs` | provider | 流式请求默认超时 |
| `maxRetries` | provider | 默认重试次数 |
| `extraBody` | provider | 请求体附加字段 |
| `dropParams` | provider、model、modelOverrides | 删除请求字段 |
| `defaultThinkingLevel` | model、modelOverrides | 选择模型时采用的等级 |

思考和删除参数按 provider、model、modelOverrides 顺序解析。请求改写需要声明 `baseUrl` 和 `api`，支持 `openai-completions` 与 `openai-responses`。

只设置 `defaultThinkingLevel` 时直接处理模型选择事件，恢复会话保留历史等级。推理能力需显式声明 `reasoning: true`。

## 认证

运行时密钥优先于存储凭据，存储凭据优先于配置密钥。SDK 统一处理 `models.json`、`auth.json` 和登录状态。

| 值 | 解释 |
| --- | --- |
| `"sk-..."` | 明文 |
| `"$NAME"`、`"${NAME}"` | 环境变量 |
| `"!command"` | 请求时执行命令取值 |
| `"$$"`、`"$!"` | 字面量 `$`、`!` |

自定义服务的环境变量需显式引用。无认证服务可使用服务允许的占位密钥，如 local。`EMPTY` 也是普通密钥字符串。

自定义 Authorization 可覆盖默认 Bearer。只使用自定义请求头的服务仍需提供原生可用凭据或占位密钥。调用方可用 null 请求头移除对应字段。

配置可能含密钥，Unix 下可限制权限：

```bash
chmod 600 ~/.pi/agent/models.json
```

## 兼容选项

`compat` 使用 SDK 原生字段，未配置项采用 SDK 行为。`chatTemplateKwargs`、`chatTemplateArgs` 和提供方路由对象按原生规则合并。

```json
{
  "thinkingPreset": "chat-template",
  "compat": {
    "supportsReasoningEffort": false,
    "chatTemplateKwargs": { "enable_thinking": { "$var": "thinking.enabled" } }
  }
}
```

显式预设优先于 SDK 检测格式。预设表见[思考传递](thinking.md)，改写顺序见[请求体](payload.md)。

## GUI 模型服务

表单保留注释、未修改字段和其他服务配置。输入模型 ID 可筛选候选，也可手动添加。只有 `modelOverrides` 的 ID 也可加入 models。

候选请求使用当前会话已加载的地址、认证和 provider 请求头。首次添加服务或修改连接信息后，保存并重载再查询。添加模型可以连续保存后统一重载。

配置与会话不一致时显示“待重载”。model-suffix 模式根据真实候选 ID 补全尚未配置的能力与映射，已有配置优先。

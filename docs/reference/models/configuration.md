# 模型配置与认证

扩展与 SDK 共用 `models.json`。GUI 保存后执行 `/reload` 或点击“重载资源”，应用到当前会话。

## 原生字段

provider 使用 Pi 原生 `baseUrl`、`api`、`apiKey`、`headers`、`compat`、`models` 和 `modelOverrides`。`models` 是包含 ID 的对象数组。

`api` 支持 Pi 已注册的协议，包括 `anthropic-messages`、`google-generative-ai` 和自定义 API。模型可覆盖 provider 的 `api` 和 `baseUrl`。内置服务继续按 SDK 规则继承连接配置、模型目录和认证，opi 不替换 provider。

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
| `extraBody` | provider | 请求体附加字段 |
| `dropParams` | provider、model、modelOverrides | 删除请求字段 |
| `defaultThinkingLevel` | model、modelOverrides | 选择模型时采用的等级 |

provider 的 `dropParams` 与有效模型的 `dropParams` 依次应用，模型覆盖优先于模型定义。请求改写通过 Pi 的 `before_provider_request` 会话事件处理，不限制 API，也不额外要求声明 `baseUrl` 或 `api`。具体字段遵循对应适配器的 payload 格式。

`timeoutMs`、`maxRetries` 扩展已移除。请从旧配置中删除这两个字段，加载与保存会提示错误，不会静默忽略。请求超时与重试使用 SDK 原生行为。

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

认证请求头遵循各 API 协议。自定义 Authorization 可覆盖对应默认值。只使用自定义请求头的服务仍需提供原生可用凭据或占位密钥。调用方可用 null 请求头移除对应字段。

配置可能含密钥，Unix 下可限制权限：

```bash
chmod 600 ~/.pi/agent/models.json
```

## 兼容选项

`compat` 使用 SDK 原生字段，未配置项采用 SDK 行为。`chatTemplateKwargs`、`chatTemplateArgs` 和提供方路由对象按原生规则合并。

```json
{
  "compat": {
    "thinkingFormat": "chat-template",
    "supportsReasoningEffort": false,
    "chatTemplateKwargs": { "enable_thinking": { "$var": "thinking.enabled" } }
  }
}
```

Chat Completions 的标准格式直接设置 `compat.thinkingFormat`，未配置时继承或使用 SDK 检测结果。Responses 使用 SDK 原生 reasoning。思考配置见[思考传递](thinking.md)，改写顺序见[请求体](payload.md)。

## GUI 模型服务

加载配置或从 JSON 切换到表单前，必须通过语法和 schema 校验。无效配置留在源码编辑器中修正。表单编辑中的临时无效输入会提示错误并禁止保存，不自动切换到源码。

仅有 `modelOverrides` 而没有本地模型定义时，表单不猜测 SDK 模型的默认值，显式修改仍需保存，也可重置为继承。

表单展示所有配置服务，API 选单从 SDK 注册表动态生成，只能选择已注册的协议。选中后明确写入 `api`，不提供省略字段或手动输入协议的选项。表单保留注释、未修改字段和其他服务配置。输入模型 ID 可筛选候选，也可手动添加。只有 `modelOverrides` 的 ID 也可加入 models。

候选请求使用当前会话已加载的地址、认证和 provider 请求头。首次添加服务或修改连接信息后，保存并重载再查询。添加模型可以连续保存后统一重载。

配置与会话不一致时显示“待重载”。候选使用 Pi 调用所需的模型 ID，只在用户添加模型时写入配置。Google 返回的 `models/` 资源前缀会移除。远端候选查询不会自动注册模型或改写配置。其他协议只读取当前会话的 SDK 目录，不触发联网刷新或配置重载。目录更新沿用 SDK 和会话启动时的刷新机制。

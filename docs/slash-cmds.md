# Slash commands

本页记录 `agent/extensions/` 提供的斜杠命令。除 `/skill:<name>` 外，命令都通过 `pi.registerCommand()` 注册。注册时命令名不含 `/`，在 Pi 输入框中以 `/命令名` 调用。`/skill:<name>` 的候选项来自 Pi 的技能发现，由本扩展的输入钩子接管。

斜杠命令处理器是展示适配器，不是图形用户界面 API。可复用逻辑位于对应功能的查询、服务或控制器。其他适配器应直接消费可安全序列化为 JSON 的快照、结果或进度，不要解析本页所列的通知文本。

## `/tools`

来源：`agent/extensions/cmd-slash-tools.ts`

用途：在 TUI 中打开工具选择列表，启用或禁用当前会话可用的工具。

用法：

```text
/tools
```

行为：

- 仅支持 TUI 模式。非 TUI 模式会提示错误。
- 列出 `pi.getAllTools()` 返回的所有工具。
- 切换后立即调用 `pi.setActiveTools()` 生效。
- 选择结果写入当前会话分支的 `tools-config` 自定义条目。会话开始或切换分支时，按当前分支恢复。
- 恢复时过滤已经不存在的工具名。
- 当前分支没有覆盖项时，读取默认工具配置：用户级 `~/.pi/agent/tools.jsonc`，项目级 `.pi/tools.jsonc`。
- `defaults` 设置所有模型的工具默认值。`rules[].match` 匹配 `${model.provider}/${model.id}`，`rules[].tools` 设置匹配模型的工具值。
- 规则先按第一个 `*` 之前的静态前缀长度从短到长应用。`*` 可以匹配 `model.id` 中的 `/`。精确匹配优先。相同优先级时，后声明的规则覆盖先声明的规则。
- 会话开始、切换分支或切换模型时重新计算配置。当前分支的 `/tools` 手动选择仍优先于文件配置。
- 用户配置先应用，项目配置后应用。未声明的工具默认启用。
- 配置恢复、按模型解析默认值、分支覆盖、设置、切换、重置和 `tools-config` 持久化由 `ToolSelectionController` 负责。空选择、未知工具、配置错误和已删除工具会返回结构化结果。TUI 的 `SettingsList` 只消费快照。

```jsonc
{
  "$schema": "./schemas/tools.schema.json",
  "defaults": {
    "websearch": true,
    "webfetch": true
  },
  "rules": [
    {
      "match": "openai-codex/*",
      "tools": {
        "websearch": false,
        "webfetch": false
      }
    },
    {
      "match": "google/*",
      "tools": {
        "websearch": false,
        "webfetch": false
      }
    }
  ]
}
```

## `/system`

来源：`agent/extensions/system-prompt.ts`

用途：在 TUI 中只读查看当前合成的系统提示词。

用法：

```text
/system
```

行为：

- 仅支持 TUI 模式。非 TUI 模式直接返回。
- 使用 `ctx.getSystemPromptOptions()` 重新构建本项目实际发送给模型的系统提示词。
- 通过自定义界面展示，不写入会话历史。
- 标题栏同时显示字符数、词元估算和原始行数。词元估算不触发网络分词器。
- 关闭：`Esc`、`q` 或 `Enter`。
- 滚动：方向键、`PageUp`、`PageDown`、`Home`、`End`。

## `/skill:<name>`

来源：`agent/extensions/skill-context.ts`

用途：由宿主加载 Pi 技能，并把完整正文作为不触发推理的自定义消息写入上下文。

用法：

```text
/skill:demo
```

行为：

- 直接读取对应的完整 `SKILL.md`，移除前置元数据后写入正文。
- `/skill:<name>` 的命令候选项来自 Pi 内置的技能发现。执行阶段由本扩展的输入钩子接管。
- 不启动模型，不产生助手消息，也不触发 `read` 工具。
- 手动加载可以加载任意已发现的技能，不受 `disable-model-invocation` 限制。
- 与模型的 `skill` 工具共用加载、校验、分支记录和去重逻辑。
- 不披露真实文件路径。附属资源使用 `read skill://<name>/<relative-path>`。

## `/skill`

来源：`agent/extensions/skill-context.ts`

用途：显示当前分支已披露的技能。

用法：

```text
/skill
```

行为：

- 显示每个技能的名称、作用域和加载来源。
- 不提供清除或卸载。上下文压缩、创建新分支或创建新会话后，旧披露会从当前状态中移除。

## `/stats`

来源：`agent/extensions/stats.ts`

用途：在 TUI 只读浮层查看当前会话统计。

用法：

```text
/stats
```

行为：

- 仅支持 TUI 模式。非 TUI 模式提示 `/stats requires TUI mode`。
- 使用 `ctx.getContextUsage()`、`ctx.getSystemPromptOptions()` 和公开的会话条目生成快照。
- 数据采集通过精简的 `StatsQueryPort` 生成可安全序列化为 JSON 的 `StatsSnapshot`。`generatedAt` 是 ISO 8601 字符串，查看器只消费该数据对象。
- 首屏展示当前请求窗口的上下文明细。分项词元由按提供方选择的计数器估算，估算值使用 `~` 标记。
- 词元计数规则见[词元计数器](token-counter.md)。
- 成本只显示为 `est`，不代表账单。
- 通过带边框的自定义界面浮层展示，不写入会话历史，也不经过模型。
- 关闭：`Esc`、`q` 或 `Enter`。
- 滚动：方向键、`PageUp`、`PageDown`、`Home`、`End`。

## `/prune`

来源：`agent/extensions/prune.ts`

用途：在下一次请求成本不会明显升高时，从模型上下文中移除已完成的历史工具事务。

用法：

```text
/prune
/prune force
/prune restore
```

行为：

- 等待当前 Agent 空闲，只处理同时存在工具调用和对应工具结果的完整事务。
- 删除目标工具调用及其结果。只包含这些调用和思考内容的助手消息也会删除。包含用户可见文本的助手消息保留文本。
- 比较下一次模型请求的估算成本。保留方案复用现有缓存。裁剪方案复用首个删除点之前的公共缓存前缀，其余部分按当前模型的 `input` 或已观测的 `cache_write` 价格计算。
- 成本始终是估算值，只覆盖已经存在的提示词，不把下一条用户输入或模型输出纳入决策。词元封装开销、工具参数模式和图片词元均为估算值。
- 缓存命中行为取决于提供方。`usage` 与价格字段只能作为缓存证据，不能完全证明缓存一定命中。
- 高置信度估算下，裁剪成本不高于保留成本的 1.1 倍时生效。低置信度估算只在裁剪明确更便宜时生效。否则提示保留上下文更省钱，不修改状态。
- `/prune force` 是唯一跳过上述成本和缓存假设的路径。它跳过模型价格和词元成本计算，强制裁剪当前所有尚未裁剪的完整工具事务。产生的裁剪状态仍可用 `restore` 撤销。
- 生效状态以不进入模型上下文的自定义会话条目保存。原始消息和 JSONL 不删除。命令执行后新产生的工具事务不受本次裁剪影响。
- TUI 会话记录只显示当前分支最新检查点的一行聚合摘要，包含本次 `prune` 或 `restore` 的数量和当前隐藏总数。历史检查点仍保留在会话中。
- 加载会话或通过 `/tree` 切换分支时，摘要状态按目标分支同步。非 TUI 模式不创建视觉状态。
- `/prune restore` 撤销最近一次尚未撤销的成功裁剪。连续执行会逐次向前恢复。恢复同样只追加状态，不改写原始消息或已有条目。
- `restore` 会先检查当前分支经过上下文压缩处理后的上下文，确认本次新增的每个工具调用及其结果仍然存在。若上下文压缩已移除任一事务，则不写入恢复状态，也不执行部分恢复。
- `prune`、`force` 和 `restore` 由 `PruneService` 串行执行。服务等待 Agent 空闲并返回结构化结果。通知文本由展示层生成，TUI 摘要完全由分支条目投影。

## `/telemetry`

来源：`agent/extensions/telemetry.ts`

用途：实时查看当前会话中采集器已经观测到的工具遥测分析。

用法：

```text
/telemetry
```

行为：

- 对当前采集器的内存快照使用离线报告的同一套分析器，不维护第二套统计逻辑。
- 实时报告是可安全序列化为 JSON 的数据传输对象。TUI 查看器和非 TUI 的摘要格式化器消费同一份报告。
- 展示工具调用量、成功率、错误、耗时和修复，多文件编辑批次，以及候选 conversion@K、MRR、LSP 来源族和细分来源。
- 只分析已经完成并成功写入遥测的调用。正在执行的调用只显示数量。
- 不扫描旧的 `run` 记录。切换会话后从新会话的观测重新开始。
- TUI 中通过只读浮层展示。非 TUI 模式使用界面通知输出。
- 不写入会话历史，不进入模型上下文。
- 关闭：`Esc`、`q` 或 `Enter`。
- 滚动：方向键、`PageUp`、`PageDown`、`Home`、`End`。

## `/usage`

来源：`agent/extensions/usage.ts`

用途：查询已通过 Pi OAuth 登录的官方套餐当前消耗和额度窗口。

用法：

```text
/usage
/usage --refresh
```

行为：

- 支持 Claude (`anthropic`)、Codex (`openai-codex`)、Kimi Code (`kimi-coding`) 和 Grok (`xai`)。只展示已通过 OAuth 登录的提供方，未登录项隐藏。全部未登录时显示统一空状态。GitHub Copilot、OpenRouter、Radius 暂无相同的额度窗口查询。
- 凭据仅通过 `ctx.modelRegistry.getProviderAuth()` 获取。只有 OAuth 凭据用于请求，API key 凭据不会用于额度请求。
- 并发查询各提供方。单个提供方失败只在对应区块显示脱敏错误。
- 使用 ASCII 进度条展示剩余和已用百分比、窗口周期和重置时间，并补充提供方返回的套餐、额度或额外用量信息。
- Codex 直接使用 Pi OAuth 查询用量和累积重置额度，不依赖 `codex` 命令或 `app-server`。宽屏使用表格，窄屏使用分块列表，展示状态、发放时间、到期时间和相对到期时间。详情查询失败时仍保留额度窗口与可用数量。
- 结果缓存 60 秒。`--refresh` 强制刷新。
- TUI 使用只读浮层。非 TUI 模式通过界面通知输出。结果、OAuth 令牌和响应正文不写入会话历史或模型上下文。
- 提供方的额度接口没有公开的稳定性承诺。请求有超时、响应大小和结构限制。接口变化只会使对应提供方降级失败。
- `UsageService.load()` 在输出边界把所有日期转换为 ISO 8601 字符串，并返回可安全序列化为 JSON 的快照。TUI 与纯文本格式化器不接触提供方客户端内部的 `Date` 对象。
- 关闭：`Esc`、`q` 或 `Enter`。内容较长时可滚动。

## `/presence`

来源：`agent/extensions/discord-presence.ts`

用途：控制 Discord Rich Presence 活动状态。

用法：

```text
/presence
/presence status
/presence on
/presence off
/presence reload
/presence profile <name>
```

行为：

- 仅支持 TUI 模式。非 TUI 模式提示 `/presence requires TUI mode`。
- `/presence` 和 `/presence status` 显示当前开关状态、展示档位和 Discord 连接状态。
- `on` 临时启用当前会话。`off` 临时关闭当前会话。两者都不修改配置文件。
- `reload` 重新读取默认、用户和项目配置。运行时开关覆盖会保留。原展示档位仍存在时，档位覆盖也会保留。
- `profile <name>` 临时切换到内置或用户定义的展示档位。参数补全读取当前配置。
- 新 Pi 会话重新使用配置中的 `enabled` 和 `profile`。完整配置说明见[Discord Presence](discord-presence.md)。

## `/thinking-level`

来源：`agent/extensions/thinking-level.ts`

用途：修改当前模型的思考级别。

用法：

```text
/thinking-level
/thinking-level <level>
```

行为：

- 无参数时需要交互界面。选择器只展示 Pi 判定为当前模型支持的等级。
- `thinkingLevelMap` 中值为 `null` 的等级不会展示。
- 模型最终使用 `chat_template_kwargs.enable_thinking` 布尔控制时，包括 OpenAI Completions 兼容模式和 OpenAI Responses 请求阶段预设，优先显示为 `off → disabled`，其他支持等级显示为 `enabled`。
- 存在字符串映射时显示为 Pi 等级到提供方值的映射，例如 `xhigh → max`。
- 带 `<level>` 时只接受当前模型支持的 Pi 等级，再调用 `pi.setThinkingLevel()`。
- 参数补全同样跟随当前模型，并显示上述映射。
- 每个 `provider/modelId` 分别记忆最近选择的等级。通过 `/model` 或 Ctrl+P 切回模型时自动恢复，不继承另一个模型的等级。
- 偏好通过隐藏的会话条目按分支持久化。会话恢复以及通过会话树或 fork 创建分支后，从当前分支重建。偏好不跨独立会话共享。
- 模型切换产生的临时等级限制不会覆盖已保存偏好。历史等级不再受支持时，保存实际限制后的等级。
- 没有当前模型、等级无效或等级不受支持时，不改写当前设置。

## `/agents`

来源：`agent/extensions/subagent.ts`

用途：列出当前可用的子代理，不经过主模型。

用法：

```text
/agents
```

行为：

- 读取 `~/.pi/agent/agents/*.md` 和 `~/.agents/agents/*.md`。
- 用户配置允许项目 Agent 时，读取最近项目的 `.pi/agents/*.md`，以及当前目录和祖先目录中的 `.agents/agents/*.md`。
- 展示名称、描述、来源、文件路径、模式、模型、工作目录、实际可用工具和是否有写能力。
- 隔离模式的工具列表是 Agent 配置工具与 `pi.getAllTools()` 的交集。`subagent` 不会传给子进程。主 Agent 通过 `/tools` 停用的工具仍会显示并传给隔离子进程。
- fork 模式继承主会话当前启用的工具，因此受 `/tools` 当前选择影响。
- 结果只显示在界面中，不写入会话历史，不消耗模型词元。

## `/run`

来源：`agent/extensions/subagent.ts`

用途：按固定工作池运行一个或多个子代理任务，不先交给主模型决定。

用法：

```text
/run <agent> "task" | <agent> "task"
```

示例：

```text
/run scout "inspect backend auth" | reviewer "inspect auth tests"
/run scout "inspect auth" | planner "create a plan from {previous}"
```

行为：

- 支持单引号和双引号。
- 使用 `|` 分隔任务段。
- 直接调用子代理执行器。
- 任一任务包含 `{previous}` 时自动串行，否则并行。
- 并发数来自合并后的子代理配置，默认文件为 `agent/defaults/subagent.jsonc`。
- 单个任务失败时，默认不取消其他任务。
- 启用写入确认且任务使用写能力工具时，需要界面确认。没有界面而无法确认时，拒绝执行需要确认的任务。用户级 Agent 可用 `auto_confirm: true` 跳过确认。
- 主 TUI 在编辑器上方实时展示运行进度、事件、耗时和词元。结束后卡片进入会话记录。
- 最终卡片不进入模型上下文，不消耗模型词元。
- `subagent` 模型工具与 `/run` 都调用 `runSubagentTasks()`，共享 `starting`、`running`、`completed` 三个 `SubagentProgressEvent` 阶段和最终 `SubagentToolResult`。TUI 部件只是进度消费者。RPC、JSON 和 print 模式不创建组件工厂，并通过通知返回核心结果。

## `/subagent-config`

来源：`agent/extensions/subagent.ts`

用途：显示当前子代理运行配置摘要。

用法：

```text
/subagent-config
```

行为：

- 展示并发、超时、重试、输出预算、项目 Agent 开关、写入确认和默认工具。
- 只显示界面通知，不写入会话历史。

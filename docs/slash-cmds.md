# Slash commands

本页只记录 `agent/extensions/` 中通过 `pi.registerCommand()` 注册的命令。命令名注册时不带 `/`，在 Pi 输入框中以 `/命令名` 调用。

Slash handler 是 presentation adapter，不是 GUI API。可复用能力位于对应 feature 的 query/service/controller；新 adapter 应直接消费 JSON-safe snapshot、outcome 或 progress，不解析本页记录的通知文本。

## `/tools`

来源：`agent/extensions/cmd-slash-tools.ts`

用途：在 TUI 中打开工具开关列表，启用或禁用当前会话可用工具。

用法：

```text
/tools
```

行为：

- 仅支持 TUI 模式；非 TUI 模式会提示错误。
- 列出 `pi.getAllTools()` 返回的所有工具。
- 切换后立即调用 `pi.setActiveTools()` 生效。
- 当前选择会写入会话分支的 `tools-config` 自定义条目；会话开始或切换分支时按当前分支恢复。
- 恢复时会过滤已不存在的工具名。
- 没有 session 覆盖时读取默认工具配置：用户级 `~/.pi/agent/tools.jsonc`，项目级 `.pi/tools.jsonc`。
- `defaults` 设置所有模型的工具默认值；`rules[].match` 匹配 `${model.provider}/${model.id}`，`rules[].tools` 设置该模型的工具值。
- `match` 只把 `*` 视为通配符，且可跨越 model id 内的 `/`；规则按第一个 `*` 之前的最长静态前缀从短到长合并，精确匹配最高，相同优先级后声明者覆盖前者。
- 模型启动、恢复或切换时重新计算配置；session 中的 `/tools` 手动选择仍优先于文件配置。
- 用户配置先应用，项目配置整体后应用；未声明的工具默认启用。
- 配置恢复、model-aware defaults、branch override、set/toggle/reset 和 `tools-config` 持久化由 `ToolSelectionController` 负责；空选择、未知工具、配置错误和已删除工具都有结构化 outcome，TUI `SettingsList` 只消费 snapshot。

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

用途：在 TUI 中只读查看当前合成后的 system prompt。

用法：

```text
/system
```

行为：

- 仅支持 TUI 模式；非 TUI 模式直接返回。
- 使用 `ctx.getSystemPromptOptions()` 重新构建本项目实际发送给模型的 system prompt。
- 通过 custom UI 展示，不写入会话历史。
- 标题栏显示字符数、同步 token 估算和原始行数；token 估算不触发网络 tokenizer。
- 关闭：`Esc`、`q` 或 `Enter`。
- 滚动：方向键、`PageUp`、`PageDown`、`Home`、`End`。

## `/skill:<name>`

来源：`agent/extensions/skill-context.ts`

用途：Host 侧加载 Pi skill，并把完整正文作为不触发推理的 custom message 写入上下文。

用法：

```text
/skill:demo
```

行为：

- 直接读取对应完整 `SKILL.md`，去除 frontmatter 后披露正文。
- 命令列表中的 `/skill:<name>` 来自 Pi 内置 skill discovery；执行阶段由本扩展 input hook 接管。
- 不启动模型，不产生 assistant message，不触发 read 工具。
- 手动加载可以加载任意已发现 skill，不受 `disable-model-invocation` 限制。
- 与模型的 `skill` 工具共用加载、校验、分支记录、去重和 UI 逻辑。
- 不披露真实路径；二级资源使用 `read skill://<name>/<relative-path>`。

## `/skill`

来源：`agent/extensions/skill-context.ts`

用途：显示当前分支已披露的 skill。

用法：

```text
/skill
```

行为：

- 显示每个 skill 的名称、scope 和加载来源。
- 不提供 clear 或 unload；旧披露由 context compaction、新 branch 或新 session 移除。

## `/stats`

来源：`agent/extensions/stats.ts`

用途：在 TUI 只读浮层查看当前会话统计。

用法：

```text
/stats
```

行为：

- 仅支持 TUI 模式；非 TUI 模式提示 `/stats requires TUI mode`。
- 使用 `ctx.getContextUsage()`、`ctx.getSystemPromptOptions()` 和公开 session entries 生成快照。
- 数据采集通过窄 `StatsQueryPort` 生成 JSON-safe `StatsSnapshot`；`generatedAt` 是 ISO 8601 字符串，viewer 只消费该 DTO。
- 首屏展示当前请求窗口的 context breakdown；分项 token 通过 provider-aware counter 估算，估算值使用 `~` 标记。
- token counter 规则见 [Token Counter](token-counter.md)。
- 成本只显示为 `est`，不代表账单。
- 通过带边框的 custom UI 浮层展示，不写入会话历史，不经过模型。
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

- 等待当前 agent loop 结束，只处理同时存在 tool call 和对应 tool result 的完整事务。
- 删除目标 call、result，以及只服务于这些 call 的 thinking/tool-only assistant 消息；带用户可见文本的 assistant 消息保留文本。
- 比较下一次 prompt 的估算成本：保留方案复用现有缓存；裁剪方案复用首个删除点之前的公共缓存前缀，其余按当前模型的 input 或已观测 cache-write 价格计算。
- 成本始终是估算值，只覆盖已经存在的 prompt，不把下一条用户输入或模型输出纳入决策；token framing、工具 schema 和图片 token 均为估算。
- 缓存命中行为依赖 provider；usage 与价格字段只能作为缓存证据，不能完全证明缓存一定命中。
- 高置信度估算下，裁剪成本更低或不超过保留成本的 1.1 倍时生效；低置信度 tokenizer 会取消这 10% 宽松条件，只在裁剪明确更便宜时生效。否则提示保留上下文更省钱且不修改状态。
- `/prune force` 是唯一跳过上述成本与缓存假设的路径：它跳过模型价格和 token 成本计算，强制裁剪当前所有完整工具事务；产生的裁剪状态仍可用 `restore` 撤销。
- 生效状态以不进入模型上下文的 session custom entry 保存。原始消息和 JSONL 不删除；命令执行后新产生的工具事务不受本次裁剪影响。
- TUI transcript 只显示当前分支最新 checkpoint 的一行聚合摘要，包含本次 prune/restore 数量和当前隐藏总数；历史 checkpoint 仍保留在 session 中。
- session 加载或通过 `/tree` 切换分支时，摘要状态按目标分支同步；非 TUI 模式不创建视觉状态。
- `/prune restore` 撤销最近一次尚未撤销的成功裁剪；连续执行会逐次向前恢复。恢复同样只追加状态，不改写原始消息或已有条目。
- restore 会先检查当前 branch 的 compaction-aware context 中，本次新增的每个 tool call 及对应 result 是否仍存在；若 compaction 已移除任一事务，则不写 restore 状态，也不做部分恢复。
- preview/apply/force/restore 由 `PruneService` 串行执行；service 等待 idle、支持取消并返回结构化 outcome。通知文本在 presentation 层生成，TUI 摘要完全由 branch entries 纯投影。

## `/telemetry`

来源：`agent/extensions/telemetry.ts`

用途：实时查看当前 session 中 collector 已观测到的工具遥测分析。

用法：

```text
/telemetry
```

行为：

- 对当前 collector 内存快照复用离线报告的同一套 analyzer，不维护第二套统计逻辑。
- live report 是 JSON-safe DTO；TUI viewer 和非 TUI summary formatter 消费同一份报告。
- 展示工具调用量、成功率、错误、耗时和 repair，edit 多文件 batch，以及候选 conversion@K、MRR、LSP 来源族和细分来源。
- 只分析已经完成并成功写入遥测的调用；正在执行的调用只显示数量。
- 不扫描旧 run；切换 session 后从新 session 的观测重新开始。
- TUI 中通过只读浮层展示；非 TUI 模式使用 UI notification 输出。
- 不写入会话历史，不进入模型上下文。
- 关闭：`Esc`、`q` 或 `Enter`。
- 滚动：方向键、`PageUp`、`PageDown`、`Home`、`End`。

## `/usage`

来源：`agent/extensions/usage.ts`

用途：查询已通过 Pi OAuth 登录的官方 plan 当前消耗和额度窗口。

用法：

```text
/usage
/usage --refresh
```

行为：

- 支持 Claude (`anthropic`)、Codex (`openai-codex`)、Kimi Code (`kimi-coding`) 和 Grok (`xai`)；只展示已通过 OAuth 登录的 provider，未登录项隐藏，全部未登录时显示统一空状态。GitHub Copilot、OpenRouter、Radius 暂无同类额度窗口查询。
- 凭据仅通过 `ctx.modelRegistry.getProviderAuth()` 获取并自动刷新；API key 不会发送到订阅额度端点。
- 并发查询各 provider；单个 provider 失败只在对应区块显示脱敏错误。
- 用 ASCII 进度条展示剩余/已用百分比、窗口周期和重置时间，并补充 provider 返回的 plan、credits 或 extra usage 信息。
- Codex 直接使用 Pi OAuth 查询 usage 和 banked reset credits，不依赖 `codex` 命令或 app-server；宽屏使用表格、窄屏使用分块列表展示状态、标题、发放时间、到期时间和相对过期时长，详情查询失败时仍保留 usage 窗口与可用数量。
- 结果缓存 60 秒；`--refresh` 强制刷新。
- TUI 使用只读浮层；非 TUI 模式通过 UI notification 输出。结果、OAuth token 和响应正文不写入会话历史或模型上下文。
- Provider 的额度接口未公开承诺稳定性；响应有超时、大小和结构边界，接口变化只会让对应 provider 降级失败。
- `UsageService.load()` 在输出边界把所有日期转换为 ISO 8601 字符串并返回 JSON-safe snapshot；TUI 与纯文本 formatter 不接触 provider client 的内部 `Date`。
- 关闭：`Esc`、`q` 或 `Enter`；内容较长时可滚动。

## `/thinking-level`

来源：`agent/extensions/thinking-level.ts`

用途：修改当前模型的 Pi thinking level。

用法：

```text
/thinking-level
/thinking-level <level>
```

行为：

- 无参数时需要 UI；选择器只展示 Pi 判定为当前模型支持的等级。
- `thinkingLevelMap` 中值为 `null` 的等级不会展示。
- 模型最终使用 `chat_template_kwargs.enable_thinking` 布尔控制时（包括 OpenAI Completions compat 和 OpenAI Responses 请求期 preset），优先显示为 `off → disabled`，其他支持等级显示为 `enabled`。
- 存在字符串映射时显示为 `Pi 等级 → provider 值`，例如 `xhigh → max`。
- 带 `<level>` 时只接受当前模型支持的 Pi 等级，再调用 `pi.setThinkingLevel()`。
- 参数补全同样跟随当前模型，并显示上述映射。
- 无当前模型、无效等级或不受支持等级不会改写当前设置。

## `/agents`

来源：`agent/extensions/subagent.ts`

用途：列出当前可用 subagent，不经过主模型。

用法：

```text
/agents
```

行为：

- 读取 `~/.pi/agent/agents/*.md` 和 `~/.agents/agents/*.md`。
- 仅在用户配置允许时读取项目 `.pi/agents/*.md` 和祖先 `.agents/agents/*.md`。
- 展示名称、描述、来源、文件路径、模型、实际可用工具和是否有写能力。
- 工具列表是 subagent 配置工具与 `pi.getAllTools()` 的交集；被 `/tools` 从主 Agent 停用的工具仍可显示并传给子进程。
- 结果只显示在 UI 中，不写入会话历史，不消耗模型 token。

## `/run`

来源：`agent/extensions/subagent.ts`

用途：按固定 worker pool 运行一个或多个 subagent 任务，不先交给主模型决定。

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
- `|` 分隔任务段。
- 直接调用 subagent executor。
- 任一任务包含 `{previous}` 时自动串行，否则并行。
- 并发数来自合并后的 Subagent 配置，默认文件为 `agent/defaults/subagent.jsonc`。
- 单个任务失败默认不取消其他任务。
- 写能力工具需要确认；无 UI 时拒绝执行。
- 主 TUI 在编辑器上方实时展示运行进度、事件、耗时和 token；结束后卡片进入聊天记录。
- 最终卡片不进入模型上下文，不消耗模型 token。
- model tool 与 `/run` 都调用 `runSubagentTasks()`，共享 `starting/running/completed` 的 `SubagentProgressEvent` 和最终 `SubagentToolResult`。TUI widget 只是 progress consumer；RPC/JSON/print 不创建 component factory，并通过通知返回核心结果。

## `/subagent-config`

来源：`agent/extensions/subagent.ts`

用途：显示当前 subagent 运行配置摘要。

用法：

```text
/subagent-config
```

行为：

- 展示并发、超时、重试、输出模式、项目 Agent 开关、写确认和默认工具。
- 只显示 UI 通知，不写入会话历史。

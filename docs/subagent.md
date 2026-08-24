# Subagent 扩展

本扩展提供轻量 subagent：每次调用启动独立 `pi` 子进程，Agent frontmatter 固定选择隔离或 fork 上下文。它不是多 Agent 框架，不实现后台会话、持久记忆、递归 subagent 或复杂 DSL。

入口：

* `agent/extensions/subagent.ts`：注册 `subagent` 工具和 slash commands。
* `agent/extensions/system-prompt.ts`：统一构建主 Agent 与子 Agent 的 system prompt。
* `src/subagent/`：配置、Agent 发现、执行、进程、输出、命令和 renderer。

## Agent 定义

用户级 Agent 位于：

```text
~/.pi/agent/agents/*.md
~/.agents/agents/*.md
```

项目级 Agent 位于：

```text
.pi/agents/*.md
.agents/agents/*.md
```

项目 Agent 默认关闭，只有用户配置显式开启时加载。
`.agents/agents` 与 Pi 内置 `.agents/skills` 发现范围保持一致：启用项目 Agent 后，会从当前目录向上查找祖先目录的 `.agents/agents`，遇到 Git 根目录停止。用户级同名时 `~/.pi/agent/agents` 优先。项目级同名是否覆盖用户级仍由 `project_agents_override_user` 控制。

格式：

```markdown
---
name: scout
description: Fast read-only codebase reconnaissance
fork: false
tools: read, grep, find, ls
---

You are a focused codebase scout.
```

字段：

* `name`：必填。
* `description`：必填，会展示给主 Agent。
* `fork`：可选严格布尔值，缺省 `false`。字符串、数字、对象等会使定义无效并产生 warning。
* `model`：可选。只用于隔离模式。
* `tools`：逗号分隔工具列表，缺省时使用只读默认工具。只用于隔离模式。
* `timeout_ms`：可选。
* `auto_confirm`：可选。为 `true` 时跳过该 Agent 的写工具确认，仅应由受信任的用户级 Agent 使用。

Markdown 正文不会直接暴露给主 Agent。隔离模式把正文作为子 Agent system role。fork 模式把正文放在历史 snapshot 后的 user assignment 中，因此不具有 system 权威。

## 主 Agent 提示词

`system-prompt.ts` 会在主 Agent system prompt 中追加精简索引：

```xml
<subagents>
- scout: Fast read-only codebase reconnaissance
- planner: Creates concise implementation plans from supplied context
</subagents>
```

主 Agent 只知道名称和描述。工具、权限、项目 Agent 开关、确认策略和并发不交给模型控制。

子进程设置 `PI_SUBAGENT_CHILD=1`，因此子 Agent 不会看到 `<subagents>` 段。

## Subagent 提示词

### 隔离模式

父进程把原始 Agent Markdown 文件路径直接作为 Pi 的 `--system-prompt` 输入。Pi 读取文件后，`system-prompt.ts` 使用与 Agent 发现相同的 frontmatter 解析器校验文档，并用 Markdown 正文构造独立角色。名称和描述仅供主 Agent 发现与选择，不进入子 Agent prompt：

```xml
<subagent_role>
You are a subagent working for the primary agent. Complete the assigned task within its scope and return the result to the primary agent. You ALWAYS respond in user's language.

Return relevant files, line ranges, symbols, architecture notes, and unresolved questions. Do not modify files.
</subagent_role>
```

`<subagent_role>` 只在内存中的最终 prompt 出现，Agent 文件仍保持标准 Markdown + YAML 格式。它直接取代主 Agent 默认的 `<role>`。显式 `--system-prompt` 使子 Agent 不加载主 Agent 的 `SYSTEM.md`，但仍保留按自身 cwd 加载的 `AGENTS.md` 和 `APPEND_SYSTEM.md`。

### Fork 模式

父进程把主会话当前有效 system prompt 逐字写入权限受限的临时文件。子进程直接读取该文件，不重新合成日期、cwd、项目规则、skills 或 subagent 索引。Agent 正文与 task 合并成 snapshot 历史后的单个 user suffix：

```xml
<agent_instructions>
Agent Markdown body
</agent_instructions>

<task>
Task text
</task>
```

suffix 还包含固定约束：只完成指定任务、向主 Agent 返回结果、不得再次调用 subagent。正文不会进入 system prompt。

## 工具可用性

子 Agent 实际获得的工具是：

```text
Agent 配置工具 ∩ pi.getAllTools()
```

并且始终过滤 `subagent`。

以上规则只适用于隔离模式。Fork 模式传递主会话 active tools 的名称和顺序，包括 `subagent`。子进程从当前 Pi runtime 加载对应工具定义。Agent/config 的 tools 不生效。子进程执行 `subagent` 时由 runtime 明确拒绝递归，而不是删除 schema。

隔离模式中：

* 配置中写了不存在的工具不会传给子进程。
* 被 `/tools` 从主 Agent 停用的工具仍可传给子进程。
* 未注册或被 Pi registry 排除的工具不会显示在 `/agents`，也不会传给子进程。
* 交集为空时拒绝执行并返回明确错误。
* 子 Agent 使用 `read`/`grep`/`find`/`ls` 时可显式访问 Pi 进程可访问的绝对路径，包括 `~/.agents`。项目级 `.agents/agents` 定义文件会拒绝符号链接逃逸。

## 工具 API

工具名：`subagent`

参数：

```ts
{
	tasks: Array<{ agent: string; task: string; cwd?: string }>;
}
```

`tasks` 是必填非空数组。隔离 task 可单独设置 workspace 内的 `cwd`，缺省时使用 workspace。fork task 忽略该字段并使用主会话 cwd。所有 task 默认并行调度。任一 `task` 包含 `{previous}` 时自动切换为 chain，后续任务会把它替换为上一步结果。输出形式也由工具按长度自动决定，模型不能指定。

工具参数不包含 fork、模型选择、安全策略、Agent 搜索范围、并发、重试或权限开关。`fork` 只能由 Agent frontmatter 决定。隔离模型由 Agent/config 决定。fork 模型固定为主会话当前模型。

## 斜杠命令

确定性命令不经过主模型：

```text
/agents
/run <agent> "task" | <agent> "task"
/subagent-config
```

`/agents` 展示 `mode: isolated|fork`。隔离 Agent 展示配置与已注册工具的交集。fork Agent 展示主会话当前实际 model、active tools 和 cwd，不展示被忽略的声明。`/run` 从当前活动 leaf 捕获 fork snapshot。

## 应用层与适配器

`runSubagentTasks()` 是 model tool 与 `/run` 的共同执行入口，返回相同的 `SubagentToolResult`，并可发送 `SubagentProgressEvent`：

```text
starting -> running* -> completed
```

`src/subagent/commands.ts` 只负责参数解析、查询和任务执行，不导入 Theme、Component、`ctx.ui` 或 widget。`src/subagent/tui/` 消费 progress，读取 expanded 状态，注册 native/entry renderer 并管理临时 widget。RPC、JSON 和 print 不加载该目录，也不会因缺少 terminal/theme 丢失最终结果。

写权限确认使用 `SubagentInteractionPort.confirmWrite()`。Pi TUI 和 RPC Extension UI 都可注入该端口。没有端口时 write-capable Agent fail closed。每次运行由 session execution registry 跟踪，正常结束释放 lease，`session_shutdown` 主动 abort 所有未结束 child。

## 执行

隔离任务启动独立 Pi 子进程：

```text
PI_SUBAGENT_CHILD=1 \
pi --mode json -p --no-session --system-prompt <agent-markdown> --model <model> --tools <tools> "Task: <task>"
```

Fork 任务使用：

```text
PI_SUBAGENT_CHILD=1 PI_SUBAGENT_FORK=1 \
pi --mode json -p \
  --fork <snapshot.jsonl> \
  --session-dir <temporary-child-dir> \
  --session-id <parent-session-id> \
  --model <parent-model> \
  --thinking <parent-thinking> \
  --tools <parent-active-tools> \
  "<fork assignment>"
```

Fork 行为：

* 使用主会话当前 model、thinking、active tools、session ID 和 cwd。
* 忽略 Agent/config 的 model、tools 以及 task cwd。差异不会触发 isolated 降级。
* fork 上下文无法建立时在 spawn 前失败。
* 模型调用工具时，沿当前 session 分支定位包含本次 subagent tool call 的 assistant entry，并从其 parent fork。前序 sequential 工具已生成 tool result 时仍使用该边界，避免把本轮尚未配对的 tool call 放入 snapshot。
* `/run` 从当前 leaf fork。
* snapshot 仅保留当前有效分支中参与模型上下文的 message、custom message、compaction 和 branch summary。普通 custom、label、model/thinking entry 不写入。
* 同次 parallel/chain 共享只读 snapshot，每个任务使用独立 child session。
* snapshot、system prompt 和所有 child session 在整次执行结束后清理。

隔离模式的 `--system-prompt` 直接引用发现阶段已校验的原始 Agent Markdown，不生成临时 prompt 或 profile。

通用行为：

* `--tools` 始终显式传递。
* `shell: false`。
* stdout 按 Pi 0.84.3 JSONL 协议解析。`message_update` 的 delta 用于实时正文，累计 usage 只取当前 turn 最新快照，`message_end` 作为最终权威消息。JSONL 损坏会使任务失败。
* `toolcall_start` 提供工具 ID 和名称后立即建立 pending 工具。`toolcall_end` 补齐参数，`tool_execution_start/update/end` 再驱动 running、completed 或 error 状态。高频流式更新最多每 50ms 向主进程发送一次 partial snapshot。
* stderr 完整保存，展示时截断。
* 超时后终止进程。
* Ctrl+C 先 `SIGTERM`，再宽限后 `SIGKILL`。
* 子进程环境变量使用白名单继承，并额外设置 `PI_SUBAGENT_CHILD=1`。

成功条件不是只看退出码。任务还必须产生非空最终 assistant 文本，且不能包含错误 stop reason 或 `errorMessage`。

## UI 卡片

subagent card 折叠态固定两行：

```text
subagent  <agent names>
  <task preview>
```

parallel 或 chain 的多任务会在第一行合并 Agent 名称，并保留完成进度、turn、token 和 cost 摘要。第二行只展示一行 task 预览。

展开态展示每个子 Agent 的 task、cwd、tools、model、文件输出、stderr、最终输出，以及实时解析到的子 Agent 行为事件：

* assistant text：流式归并同一 content block，压缩为空格后展示。最终以 `message_end` 正文替换临时 delta。
* tool call：展示工具名、精简参数和 pending/running/completed/error 状态。
* 运行中但还没有事件时展示等待状态。

模型调用 `subagent` 工具与用户手动执行 `/run` 共用同一套卡片。`/run` 运行期间由 TUI adapter 在编辑器上方消费结构化 progress，并补齐与 Pi 工具卡相同的 padding 和 pending/success/error 背景。结束后移除临时 widget，并把最终卡片写入聊天记录。展开态使用对齐字段以及 Activity、Error、Details、Result 分区。最终回答不会在 Activity 中重复。该记录使用 custom session entry 持久化，不进入模型上下文，也不消耗模型 token。

## 并发

默认配置：

```jsonc
{
	"max_parallel_tasks": 4,
	"max_concurrency": 1
}
```

默认任务调度使用固定 worker pool，不一次性启动全部任务。chain 严格串行，失败即停止。

## 输出

完整结果始终保存到 `.pi/subagents/runs/<run-id>/`。工具使用同步本地 token counter 计算输出预算，不发起网络请求。未超过 `max_inline_output_tokens` 时，主上下文直接收到完整正文。超过边界时只收到一行简短提示，说明输出过长并给出完整结果文件路径，不包含正文预览。

chain handoff：

* 未超过 inline 与 handoff 边界的结果直接传递。
* 超过任一边界的结果只传文件路径和读取指引。
* 后续 Agent 如需完整内容，应主动使用 `read` 读取文件。

## 配置

用户配置：

```text
~/.pi/agent/configs/subagent.jsonc
```

项目配置：

```text
.pi/configs/subagent.jsonc
```

项目配置在用户配置之后加载，只能覆盖普通运行参数：

* `max_parallel_tasks`
* `max_concurrency`
* `timeout_ms`
* `max_inline_output_tokens`
* `max_handoff_tokens`

项目配置不能修改 `allow_project_agents`、`project_agents_override_user`、`confirm_write_agents`、`default_tools` 或 `agent_overrides`，避免项目扩大用户级能力边界。Fork 执行还会忽略 `default_model`、`default_tools` 和对应 `agent_overrides`。`timeout_ms` 与受信任用户 Agent 的 `auto_confirm` 仍可生效。

完整默认配置位于：

```text
agent/defaults/subagent.jsonc
```

用户配置只需在 `agent/configs/subagent.jsonc` 中写覆盖字段。项目配置中的禁止字段会作为配置错误拒绝。通用规则见[配置分层](configuration.md)。

默认值以 `agent/defaults/subagent.jsonc` 为准。

配置解析失败或数值越界会直接报错，不静默回退。

## Fork 缓存与隐私边界

Fork 在 Pi 层尽力复用主请求的 system prompt、工具 schema、compaction 后消息前缀、model/provider 配置、thinking 和 session affinity，使请求接近 `parent prefix + assignment`。这不是 provider payload 字节级等价或 cache hit 保证。provider 支持、token 下限、TTL、淘汰、服务端路由，以及扩展/provider 的请求重写都会影响结果。Extension API 未完整暴露的 cache retention、headers、transport 和 metadata 不会被伪装成已保证字段。

临时文件权限用于限制其他用户访问，但不构成 provider 网络屏障。Fork Agent 会把主会话当前有效历史发送给主会话当前模型，使用前应按该模型的隐私边界评估内容。

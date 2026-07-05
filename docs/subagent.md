# Subagent 扩展

本扩展提供轻量 subagent：每次调用启动独立 `pi` 子进程，使用隔离上下文执行明确任务。它不是多 Agent 框架，不实现后台会话、持久记忆、递归 subagent 或复杂 DSL。

入口：

* `agent/extensions/subagent.ts`：注册 `subagent` 工具和 slash commands。
* `agent/extensions/system-prompt.ts`：统一构建主 Agent 与子 Agent 的 system prompt。
* `src/subagent/`：配置、Agent 发现、执行、进程、输出、命令和 renderer。

## Agent 定义

用户级 Agent 位于：

```text
~/.pi/agent/agents/*.md
```

项目级 Agent 位于：

```text
.pi/agents/*.md
```

项目 Agent 默认关闭，只有用户配置显式开启时加载。

格式：

```markdown
---
name: scout
description: Fast read-only codebase reconnaissance
tools: read, grep, find, ls
output_mode: inline
---

You are a focused codebase scout.
```

字段：

* `name`：必填。
* `description`：必填，会展示给主 Agent。
* `model`：可选。
* `tools`：逗号分隔工具列表；缺省时使用只读默认工具。
* `output_mode`：`inline` 或 `file`。
* `timeout_ms`：可选。
* `retries`：可选。

Markdown 正文不会直接暴露给主 Agent，只作为子 Agent 专属指令。

## 主 Agent 提示词

`system-prompt.ts` 会在主 Agent system prompt 中追加精简索引：

```xml
<subagents>
- scout: Fast read-only codebase reconnaissance
- planner: Creates concise implementation plans from supplied context
</subagents>
```

主 Agent 只知道名称和描述。工具、权限、项目 Agent 开关、确认策略、并发和重试不交给模型控制。

子进程设置 `PI_SUBAGENT_CHILD=1`，因此子 Agent 不会看到 `<subagents>` 段。

## 子 Agent 提示词

子 Agent 的 Agent Markdown 正文会被放入独立 XML 段，并通过 `--append-system-prompt <temp-file>` 传给子进程：

```xml
<subagent name="scout" description="Fast read-only codebase reconnaissance">
Return relevant files, line ranges, symbols, architecture notes, and unresolved questions. Do not modify files.
</subagent>
```

子 Agent 仍使用项目统一 system prompt 构建逻辑，但不会看到 subagent 列表，也不会默认获得 `subagent` 工具。工具集合由子进程启动参数限制，不在提示词中重复说明。

## 工具可用性

子 Agent 实际获得的工具是：

```text
Agent 配置工具 ∩ pi.getAllTools()
```

并且始终过滤 `subagent`。

因此：

* 配置中写了不存在的工具不会传给子进程。
* 被 `/tools` 从主 Agent 停用的工具仍可传给子进程。
* 未注册或被 Pi registry 排除的工具不会显示在 `/agents`，也不会传给子进程。
* 交集为空时拒绝执行并返回明确错误。

## 工具 API

工具名：`subagent`

参数：

```ts
{
	tasks: Array<{ agent: string; task: string; cwd?: string }>;
	mode?: "chain";
	cwd?: string;
	outputMode?: "inline" | "file";
}
```

`tasks` 是必填非空数组。默认按配置的并发限制调度任务；只有 `mode: "chain"` 会串行执行，并允许后续 task 使用 `{previous}`。`outputMode` 中 `inline` 用于短结果，`file` 用于长结果或多任务结果。

工具参数不包含模型选择、安全策略、Agent 搜索范围、并发、重试或权限开关。子 Agent 模型只由 Agent 定义和 subagent 配置决定。

## Slash commands

确定性命令不经过主模型：

```text
/agents
/run <agent> "task" | <agent> "task"
/chain <agent> "task" | <agent> "task with {previous}"
/subagent-config
```

`/agents` 展示实际可用工具，即 Agent 配置工具与已注册工具的交集。

## 执行

每次任务启动独立 Pi 子进程：

```text
pi --mode json -p --no-session --model <model> --tools <tools> --append-system-prompt <temp-file> "Task: <task>"
```

行为：

* `--tools` 始终显式传递。
* 临时 prompt 文件使用 `0600`，finally 中清理。
* `shell: false`。
* stdout 按 JSONL 解析。
* stderr 完整保存，展示时截断。
* 超时后终止进程。
* Ctrl+C 先 `SIGTERM`，再宽限后 `SIGKILL`。
* 子进程环境变量使用白名单继承，并额外设置 `PI_SUBAGENT_CHILD=1`。

成功条件不是只看退出码，必须有非空最终 assistant 文本，且没有错误 stop reason 或 provider error。

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

`inline`：

* 返回最多 `max_inline_output_chars`。
* 超出时按 Unicode 字符边界截断并标记。
* 完整结果仍写入运行目录。

`file`：

* 完整结果保存到 `.pi/subagents/runs/<run-id>/`。
* 主上下文只收到路径、大小和短预览。

chain handoff：

* inline 结果受 `max_handoff_chars` 限制。
* file 结果只传路径、大小和短预览。
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

项目配置只能覆盖普通运行参数，不能扩大安全边界。

默认配置文件位于：

```text
agent/configs/subagent.jsonc
```

重要默认值：

```jsonc
{
	"max_parallel_tasks": 4,
	"max_concurrency": 1,
	"retries": 1,
	"retry_on_empty_output": true,
	"output_mode": "inline",
	"allow_project_agents": false,
	"confirm_write_agents": true,
	"default_tools": ["read", "grep", "find", "ls"]
}
```

配置解析失败或数值越界会直接报错，不静默回退。

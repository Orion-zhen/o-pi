# 子代理

子代理为每次任务启动独立进程。定义选择隔离模式或 fork 模式，模型通过 `subagent` 调用，用户通过 `/run` 直接运行。

## 定义

用户定义位于 `~/.pi/agent/agents/*.md`。项目定义默认关闭，启用后读取当前目录向上最近的 `.pi/agents/*.md`。

```markdown
---
name: scout
description: 查找实现位置和依赖关系
fork: false
tools: read, grep, find, ls
---
定位相关文件、符号和调用关系，返回可核查的结果。
```

| 字段 | 含义 |
| --- | --- |
| `name`、`description` | 必填，主代理可见 |
| `fork` | 严格布尔值，默认 false |
| `model` | 隔离模式模型 |
| `tools` | 隔离模式工具，逗号分隔，省略时使用只读默认工具 |
| `timeout_ms`、`retries` | 该代理的超时和重试覆盖 |
| `auto_confirm` | 可信用户定义可跳过写能力确认 |

主代理只接收名称和描述索引，正文用于子代理任务。

## 两种模式

| 项目 | 隔离 | fork |
| --- | --- | --- |
| 上下文 | 独立任务 | 主会话当前有效分支快照 |
| 定义正文 | 系统角色 | 历史后的用户任务指令 |
| 模型 | Agent 与配置选择 | 主会话当前模型和思考等级 |
| 工具 | 配置与已注册工具的交集 | 主会话当前启用集合 |
| 工作目录 | 工作区内的指定目录 | 主会话目录 |

隔离模式过滤 subagent，fork 保留工具声明但在执行时拒绝递归。

fork 会把主会话历史发送给当前模型，使用前确认该模型适合处理这些内容。

## 调用

```ts
subagent({ tasks: [{ agent: "scout", task: "定位认证入口", cwd: "src" }] })
```

`tasks` 必须非空。任一任务含 `{previous}` 时按顺序执行，并将上一步结果传给下一步，否则按工作池并行调度。

```text
/agents
/run scout "检查认证" | reviewer "审查 {previous}"
/subagent-config
```

`/agents` 展示模式、模型、目录和实际可用工具。`/run` 直接执行任务，结果卡片保存在界面历史中。

## 配置

默认文件见 [`subagent.jsonc`](../../../agent/defaults/subagent.jsonc)，用户文件为 `~/.pi/agent/configs/subagent.jsonc`。路径覆盖与项目查找见[配置分层](../runtime/configuration.md)。

项目层只接受：

```text
max_parallel_tasks, max_concurrency, timeout_ms, retries,
retry_delay_ms, retry_on_empty_output, retry_on_timeout,
max_inline_output_tokens, max_handoff_tokens
```

项目代理开关、同名覆盖、写入确认和工具默认值由用户层控制。默认 `max_parallel_tasks` 为 4，`max_concurrency` 为 1。

执行、取消、重试和输出见[执行机制](execution.md)。

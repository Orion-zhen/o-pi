# RPC 支持矩阵

o-pi 复用 Pi 原生 `--mode rpc` JSONL 协议，不定义第二套传输协议。RPC client 可以直接使用 Pi 的 `get_state`、`get_commands`、`prompt`、工具事件和 Extension UI 子协议。仓库内的 data/application API 是未来 GUI、SDK 或其他 RPC adapter 的复用边界；slash command 文本、notification 文本和 TUI component 不是 GUI API。

## 分层

依赖方向固定为：

```text
data/query/service/controller -> extension or RPC adapter -> TUI adapter
```

`src/tui/**` 与各 feature 的 `tui/` 是唯一可运行时依赖 `@earendil-works/pi-tui` 的目录。RPC、JSON 和 print 启动不会加载 renderer、viewer、component factory 或 terminal/theme 代码。renderer 加载失败只影响展示，不能改变工具 schema、application promise、结构化结果或 session 状态。

## 能力矩阵

| 能力 | Pi 原生 RPC | 可复用 application seam | 当前 RPC 行为 |
| --- | --- | --- | --- |
| Session/model 状态 | `get_state` | Stats `collectStatsSnapshot()` | 原生状态可直接读取；完整 Stats DTO 不单独暴露为 RPC method |
| 命令发现 | `get_commands` | 各 extension command adapter | 可发现 extension、prompt 和 skill 命令 |
| System prompt | 无专用 o-pi RPC method | `buildAgentSystemPrompt()`、`buildRuntimeSystemPrompt()` | `/system` 是 TUI viewer，不是 RPC API |
| Stats | 无专用 o-pi RPC method | JSON-safe `StatsSnapshot` | `/stats` 仅 TUI；未来 adapter 应直接消费 snapshot |
| Usage | 无专用 o-pi RPC method | `UsageService.load()` 返回 JSON-safe snapshot | `/usage` 在 RPC 中通过 notification 输出文本 |
| Telemetry | 无专用 o-pi RPC method | collector snapshot + live report DTO | `/telemetry` 在 RPC 中通过 notification 输出文本 |
| Skill/LSP 查询 | 无专用 o-pi RPC method | `querySkillStatus()`、`queryLspStatus()`、`queryLspDiagnostics()` | slash adapter 输出文本；未来 adapter 直接消费 DTO |
| Tool Selection | `get_state` 只含 active state 的 Pi 视图 | `ToolSelectionController` snapshot/outcome | `/tools` 是 TUI 交互；controller 可由非 TUI adapter 调用 |
| Prune | 无专用 o-pi RPC method | `PruneService.execute()` outcome | `/prune` 可在 RPC 调用；通知文本不是状态协议 |
| Thinking Level | Pi 原生 thinking RPC 命令 | `ThinkingLevelController` snapshot/outcome | 带参数的 `/thinking-level` 可调用；无参数使用 Extension UI dialog |
| Subagent | 工具/command 事件 | `runSubagentTasks()`、`runSubagentCommand()`、`SubagentProgressEvent` | model tool 与 `/run` 共用结构化 progress/result；RPC 不创建 widget |
| Approval | Extension UI `select`/`input` | `ApprovalInteractionPort` | RPC dialog 可完成一次性、session、persistent 或带指令拒绝 |
| Web 认证确认 | Extension UI `confirm` | `WebFetchInteractionPort` | RPC dialog 可确认向 allowlisted origin 发送 Cookie |
| Subagent 写确认 | Extension UI `confirm` | `SubagentInteractionPort` | RPC dialog 可确认 write-capable child；没有 port 时 fail closed |

DTO、outcome 和 progress 都不得携带 `Date`、TUI component、Theme、函数或 session manager。时间在输出边界统一使用 ISO 8601 字符串。

## 非 TUI 行为

- RPC 的 `ctx.mode` 是 `rpc`，`ctx.hasUI` 为 `true`；`select`、`confirm`、`input`、`editor` 和 `notify` 走 Extension UI JSON 子协议。
- `ctx.mode === "tui"` 才允许加载 `custom()` viewer、native renderer、entry renderer 和 widget component factory。
- JSON/print 没有 dialog port。需要确认的 Approval、Web 认证和 Subagent 写任务按各自策略拒绝或降级，不模拟终端输入。
- `/run` 在 TUI 写入 host-only custom entry；RPC/JSON/print 通过 notification 返回最终文本，不把 component 当作进度或结果来源。
- `/prune`、Tool Selection 和 Thinking Level 的 correctness 只依赖 controller/service 与 session entry，不依赖 transcript renderer。

## 真实冒烟

`tests/rpc/smoke.test.ts` 启动仓库实际安装的 Pi：

```text
pi --mode rpc --no-session --offline --approve \
  --extension tests/rpc/fixtures/dialog-extension.ts
```

测试不发送模型 prompt，也不访问网络。它验证 `get_state`、`get_commands`、direct bash 的 `bash_execution_update` 与结果、工具执行后的 session 状态、`extension_ui_request`/`extension_ui_response` confirm 往返、notify、无 `extension_error`、LF-only JSONL 解析和关闭 stdin 后的零退出码。

## Adapter 契约

新 GUI 或正式 feature RPC method 应：

1. 直接调用 query/service/controller，返回原始结构化 DTO、outcome 或 progress。
2. 在 adapter 层实现 Extension UI 等价 interaction port。
3. 把 notification、slash 参数和 renderer 视为现有前端实现，不解析其文本。
4. 不导入 `pi-tui`，不模拟 `ctx.ui`，不从 TUI state 反推业务状态。

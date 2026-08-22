# RPC 支持矩阵

o-pi 复用 Pi 原生的 `--mode rpc` JSONL 协议，不另行定义传输协议。RPC 客户端可以直接调用 Pi 的 `get_state`、`get_commands` 和 `prompt`，也可以处理工具事件和 Extension UI 子协议。仓库中的查询、服务、控制器和结构化数据传输对象（DTO）是未来 GUI、SDK 或 RPC 适配器的复用边界。斜杠命令的文本输出、通知文本和 TUI 组件属于前端实现，不是 GUI API。

## 分层

模块依赖和运行时加载关系如下。箭头指向被导入或加载的模块：

```text
扩展或 RPC 适配器 -> 数据/查询/服务/控制器
扩展 --仅在 TUI 模式下动态加载--> TUI 适配器
TUI 适配器 -> 数据/查询/服务/控制器
```

只有 `src/tui/**` 和各功能的 `tui/` 目录可以在运行时依赖 `@earendil-works/pi-tui`。`rpc`、`json` 和 `print` 模式不会加载渲染器、查看器、组件工厂或终端与主题相关的代码。渲染器加载失败只能影响展示，不得改变工具定义、应用层行为、结构化结果或会话状态。

## 能力矩阵

| 能力 | Pi 原生 RPC | 可复用应用层接口 | 当前 RPC 行为 |
| --- | --- | --- | --- |
| 会话和模型状态 | `get_state` | 统计模块的 `collectStatsSnapshot()` | 可以直接读取原生状态。RPC 未单独提供完整的 `StatsSnapshot` |
| 命令发现 | `get_commands` | 各扩展的命令适配器 | 可以发现扩展、提示词和技能命令 |
| 系统提示词 | 无专用的 o-pi RPC 方法 | `buildAgentSystemPrompt()`、`buildRuntimeSystemPrompt()` | `/system` 仅提供 TUI 查看器，不是 RPC API |
| 会话统计 | 无专用的 o-pi RPC 方法 | 可安全序列化为 JSON 的 `StatsSnapshot` | `/stats` 仅支持 TUI。在 RPC 模式下调用时会发送错误通知 |
| 套餐用量 | 无专用的 o-pi RPC 方法 | `UsageService.load()` 返回可安全序列化为 JSON 的快照 | `/usage` 通过通知返回文本 |
| 遥测 | 无专用的 o-pi RPC 方法 | 采集器快照和实时报告 DTO | `/telemetry` 通过通知返回文本 |
| 技能和 LSP 查询 | 无专用的 o-pi RPC 方法 | `querySkillStatus()`、`queryLspStatus()`、`queryLspDiagnostics()` | 斜杠命令适配器输出文本。后续适配器可以直接使用 DTO |
| 工具选择 | 无专用的 o-pi RPC 方法 | `ToolSelectionController` 的快照和操作结果 | `/tools` 仅支持 TUI。在 RPC 模式下调用时会发送错误通知 |
| 上下文裁剪 | 无专用的 o-pi RPC 方法 | `PruneService.execute()` 的操作结果 | 可以通过 `/prune` 调用。通知文本不是状态协议 |
| 思考级别 | Pi 原生的思考级别 RPC 命令 | `ThinkingLevelController` 的快照和操作结果 | 可以调用带参数的 `/thinking-level`。存在当前模型时，不带参数的命令通过 Extension UI 的 `select` 请求选择级别 |
| 子代理 | 工具和命令事件 | `runSubagentTasks()`、`runSubagentCommand()`、`SubagentProgressEvent` | 模型工具与 `/run` 共用结构化进度和结果。RPC 不创建 TUI 组件 |
| 审批 | Extension UI 的 `select` 和 `input` | `ApprovalInteractionPort` | RPC 交互始终支持单次允许和拒绝。满足配置和规则条件时，还支持会话内允许和持久允许。拒绝时可以附带指令 |
| Web 认证确认 | Extension UI 的 `confirm` | `WebFetchInteractionPort` | RPC 交互可以确认是否向允许列表内的源站发送 Cookie |
| 子代理写入确认 | Extension UI 的 `confirm` | `SubagentInteractionPort` | RPC 交互可以确认是否运行具备写入能力的子代理。没有交互端口时默认拒绝 |

DTO、操作结果和进度事件不得包含 `Date`、TUI 组件、`Theme`、函数或会话管理器。输出边界使用 ISO 8601 字符串表示时间。

## 非 TUI 模式的行为

- RPC 模式下，`ctx.mode` 为 `"rpc"`，`ctx.hasUI` 为 `true`。`select`、`confirm`、`input`、`editor` 和 `notify` 通过 Extension UI JSON 子协议交互。
- 只有 `ctx.mode === "tui"` 时才能加载 `custom()` 查看器、原生渲染器、会话条目渲染器和 TUI 组件工厂。
- `json` 和 `print` 模式没有对话交互端口。需要确认时，审批、Web 认证和子代理写入任务会按各自策略拒绝或降级，不会模拟终端输入。
- `/run` 在 TUI 模式下写入仅由宿主使用的自定义会话条目。在 `rpc`、`json` 和 `print` 模式下，`/run` 通过通知返回最终文本，不把组件作为进度或结果的数据源。
- `/prune`、工具选择和思考级别的业务行为只依赖控制器、服务和会话条目，不依赖会话记录渲染器。

## 真实进程冒烟测试

`tests/rpc/smoke.test.ts` 启动仓库实际安装的 Pi：

```text
pi --mode rpc --no-session --offline --approve \
  --extension tests/rpc/fixtures/dialog-extension.ts
```

该测试不发送模型提示词，也不访问网络。测试覆盖以下行为：

- 调用 `get_state` 和 `get_commands`
- 直接执行 Bash 时接收 `bash_execution_update` 和最终结果
- 执行工具后读取会话状态
- 完成 `extension_ui_request` 和 `extension_ui_response` 的确认往返
- 接收通知，并确认没有 `extension_error`
- 解析仅使用 LF 换行的 JSONL
- 关闭标准输入后以退出码 0 结束

## 适配器契约

为新 GUI 或正式功能新增 RPC 方法时，适配器必须：

1. 直接调用查询、服务或控制器，并返回原始的结构化 DTO、操作结果或进度事件。
2. 在适配器层实现与 Extension UI 语义等价的交互端口。
3. 把通知、斜杠命令参数和渲染器视为现有前端实现，不解析其文本。
4. 不导入 `pi-tui`，不模拟 `ctx.ui`，也不根据 TUI 状态推导业务状态。

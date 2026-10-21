# RPC

CLI 的 `--mode rpc` 使用 Pi 原生 JSONL 协议。Desktop 和 Web 直接调用 SDK，通信方式见 [GUI 架构](../gui/architecture.md)。

```bash
opi --mode rpc --no-session --offline --approve
```

## 原生接口

`get_state` 读取状态，`get_commands` 发现命令，`prompt` 提交输入。会话、模型、思考等级和 Bash 事件沿用 Pi。

`prompt` 的响应包含 `data.disposition`：

| 值 | 含义 |
| --- | --- |
| `handled` | 命令或扩展已处理，没有启动运行 |
| `queued` | 输入已排队 |
| `started` | 运行已启动 |

收到 `handled` 后无需等待 `agent_settled`。

## Extension UI

RPC 的 `ctx.mode` 为 `rpc`，`ctx.hasUI` 为 `true`。`select`、`confirm`、`input`、`editor` 和 `notify` 通过 Extension UI 子协议交互。

| 功能 | RPC 行为 |
| --- | --- |
| 工具执行 | 使用原生工具事件和结果 |
| 审批 | 选择、输入，支持配置允许的单次、会话和持久放行 |
| Cookie 认证 | 通过确认接口授权 |
| 子代理写入确认 | 通过确认接口授权 |
| `/run` | 执行子代理并通过通知返回结果 |
| `/usage`、`/telemetry`、`/skill`、LSP 命令 | 通过通知返回文本 |
| `/presence` | 控制后端本机的 Discord 状态 |
| `/prune` | 执行裁剪并返回通知 |
| `/system` | 无 RPC 查看器 |
| `/stats`、`/tools` | 返回需要 TUI 的提示 |

JSON 和 print 模式没有交互端口。审批采用 `ui.non_interactive`，Cookie 认证与需要确认的子代理写入按模块规则拒绝。

## 适配接口

统计、用量、遥测、技能和子代理分别提供结构化查询、服务和进度对象。新的适配器直接使用这些对象，通知文本用于展示。

可序列化对象中的时间使用 ISO 8601 字符串。终端组件只由 TUI 装配。

`tests/rpc/smoke.test.ts` 验证真实二进制的状态、命令发现、Bash 事件、Presence 和退出。

# Reference

按模块查询配置、接口、运行行为和实现机制。操作步骤见[用户使用指南](../README.md#用户使用指南)。

## 模块

| 模块 | 内容 |
| --- | --- |
| [运行时](runtime/README.md) | 入口、SDK、配置分层、扩展、构建、测试、RPC |
| [TUI](tui/README.md) | 终端增强、配置、输入历史、公式与工具卡片 |
| [GUI](gui/README.md) | 设置、会话、文件、存储、连接、设计和诊断 |
| [文件工具](file-tools/README.md) | `ls`、`find`、`grep`、`read`、`write`、`edit` |
| [Bash](bash-tool/README.md) | 执行环境、输出管理和技能路径 |
| [网页工具](web-tools/README.md) | 搜索、抓取、网络策略和 Cookie |
| [LSP](lsp/README.md) | 服务器配置、路由、诊断和代码关系 |
| [审批](approval-gate/README.md) | 调用策略、Bash 分析和放行规则 |
| [技能](skill-context/README.md) | 发现、加载、分支状态和 `skill://` |
| [子代理](subagent/README.md) | 定义、隔离与 fork、执行和输出 |
| [提示词](prompts/README.md) | 系统提示词、工具字段和模板 |
| [模型](models/README.md) | 提供方、认证、思考、请求体和调速 |
| [Codemode](codemode/README.md) | 脚本调用、工具发现和结构化结果 |
| [MCP](mcp/README.md) | 服务配置、认证和工具可见性 |
| [自动标题](auto-title/README.md) | 命名配置和生命周期 |
| [Discord Presence](discord-presence/README.md) | 活动状态、档位、模板和进程协调 |
| [o-pet](o-pet/README.md) | 桌宠连接与端点 |
| [遥测](telemetry/README.md) | 本地采集与报告 |
| [统计与上下文](statistics/README.md) | 会话统计、用量、词元估算和裁剪 |

## 命令索引

TUI 和 GUI 在输入框执行命令。RPC 通过 `prompt` 提交命令，交互使用 Extension UI。表中的“通知”指通过该接口返回文本。

| 命令 | 作用 | 入口与说明 |
| --- | --- | --- |
| `/tools` | 选择工具、保存默认值 | TUI 选择器，GUI 工具面板。RPC 不提供选择器。见[工具选择](runtime/configuration.md#工具选择) |
| `/system` | 查看当前系统提示词 | TUI 查看器，GUI 提示词窗口。见[提示词](prompts/README.md) |
| `/skill` | 查看当前分支加载记录 | 界面通知。见[技能](skill-context/README.md) |
| `/skill:<name>` | 加载技能 | 加载后写入上下文。见[技能](skill-context/README.md) |
| `/agents` | 列出子代理 | 见[子代理](subagent/README.md) |
| `/run <agent> "task"` | 直接运行子代理 | TUI、GUI 提供进度，RPC 返回通知。见[子代理执行](subagent/execution.md) |
| `/subagent-config` | 查看子代理配置 | 界面通知 |
| `/approval-check <command>` | 查看 Bash 审批判定 | 解析而不执行命令。见[审批](approval-gate/README.md) |
| `/lsp status` | 查看 LSP 状态 | `/lsp` 为简写。见 [LSP](lsp/README.md) |
| `/lsp reload` | 重置语言服务器 | 见 [LSP](lsp/README.md) |
| `/lsp diagnostics [path]` | 查看已知诊断 | 见 [LSP](lsp/README.md) |
| `/presence [操作]` | 控制 Discord 状态 | TUI、GUI、RPC。见 [Presence](discord-presence/README.md) |
| `/codex-speed normal\|fast\|ultrafast` | 调整 OpenAI 请求档位 | 见[模型调速](models/README.md#请求档位) |
| `/stats` | 会话统计 | TUI 浮层、GUI 信息栏。RPC 返回不支持提示。见[统计](statistics/README.md) |
| `/usage [refresh]` | 套餐用量和 API 余额 | TUI 浮层、GUI 用量面板、RPC 通知。见[用量](statistics/usage.md) |
| `/telemetry` | 当前采集器报告 | TUI 浮层、GUI 信息栏、RPC 通知。见[遥测](telemetry/README.md) |
| `/prune [force\|restore]` | 裁剪或恢复工具事务 | 见[上下文裁剪](statistics/prune.md) |
| `/mcp` | MCP 设置或状态 | GUI 打开设置页，其他入口沿用 SDK。见 [MCP](mcp/README.md) |

`/model`、`/thinking`、`/login`、`/logout`、`/new`、`/resume`、`/tree`、`/fork`、`/compact` 和 `/reload` 沿用 Pi。TUI 的全部快捷键见 `/hotkeys`，GUI 的命令入口见“会话操作 → 命令帮助”。

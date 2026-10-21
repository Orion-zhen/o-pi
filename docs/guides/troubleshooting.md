# 故障排查

## 配置加载失败

按错误中的实际文件路径检查 JSONC、字段名和类型。用户配置只保留需要覆盖的字段，默认值与 schema 位于仓库的 `agent/defaults/` 和 `agent/schemas/`。

配置层级、环境变量和合并规则见[配置分层](../reference/runtime/configuration.md)。GUI 的 JSON 编辑入口可以修复损坏配置。保存冲突时先复制草稿，再重新读取文件。

## 模型不可用或请求失败

1. 检查认证和服务地址。
2. 确认 `models.json` 中的模型 ID 和 API 类型。
3. 保存后重载当前会话。
4. 检查服务返回的错误，以及思考、采样和输出上限配置。

GUI 的候选列表需要服务支持 `GET <baseUrl>/models`。列表获取失败时可以手动填写模型 ID。详细检查见[模型排障](../reference/models/troubleshooting.md)。

## 文件工具拒绝访问或编辑

- `READ_REQUIRED`：先读取目标文件。
- `STALE_READ`：文件已有外部变更，重新读取后编辑。
- `PROTECTED_PATH`：检查 `file-tools.jsonc` 中的受阻路径。
- `OLD_TEXT_NOT_UNIQUE`：使用错误返回的唯一上下文，或补充匹配文本。
- `OLD_TEXT_NOT_FOUND`：检查原文和替换之间的依赖，按提示重试。

输出截断时按结果中的续读范围或缩小搜索范围。完整行为见[文件工具](../reference/file-tools/README.md)。

## LSP 没有结果

运行 `/lsp status`，查看配置路径、状态和 `last_error`。确认语言服务器位于后端 PATH 中，命令参数和语言选择器正确。

GUI“设置 → 工具与代码 → LSP 服务器”可检查可执行文件位置。修复后运行 `/lsp reload`，下次文件工具调用会重新连接。

## 网页请求失败

检查搜索引擎凭据、[网络代理](../reference/web-tools/network.md)和域名过滤。私网网页需要审批。带 Cookie 的请求还需要域名允许列表和认证确认。

网页工具读取静态响应。结果中的 `partial` 表示存在未取得的内容，`next` 表示可以继续读取的文本位置。字段说明见 [webfetch](../reference/web-tools/webfetch.md)。

## GUI 异常或卡顿

展开页面中的“错误详情”，复制诊断信息。Desktop 的诊断日志和操作时间线位于：

| 平台 | 默认路径 |
| --- | --- |
| Windows | `%APPDATA%\opi-desktop\logs\gui-timing.jsonl` |
| macOS | `~/Library/Logs/opi-desktop/gui-timing.jsonl` |
| Linux | `~/.config/opi-desktop/logs/gui-timing.jsonl` |

Linux 设置 `XDG_CONFIG_HOME` 时使用该目录。日志轮转文件为 `gui-timing.jsonl.1`。保留两份日志和问题发生时间，字段含义见 [GUI 诊断](../reference/gui/diagnostics.md)。

界面报错后后台任务可能仍在运行，先检查任务状态，再决定是否重发。分享诊断信息前检查路径和异常文本中的敏感内容。Web 页面诊断需要手动复制保存。

## 终端快捷键或显示异常

先用 `/hotkeys` 检查当前绑定，再检查终端是否拦截组合键。换行可尝试 Ctrl+J。输入法候选位置异常可尝试 `showHardwareCursor: true`。

图片和公式显示依赖终端图片协议。终端增强的配置与机制见 [TUI Reference](../reference/tui/README.md)。

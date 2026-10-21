# GUI

Desktop 和 Web 共用 React 界面与 SDK 宿主。日常操作见 [GUI 使用指南](../../guides/gui.md)，启动与访问见[安装](../../guides/getting-started.md)和[远程访问](../../guides/remote-access.md)。

## 专题

| 文档 | 内容 |
| --- | --- |
| [配置](configuration.md) | 外观、字体、材质、发送方式和宿主设置 |
| [会话](sessions.md) | 消息、队列、分支、多客户端和实例回收 |
| [工作区与文件](workspace.md) | 目录、Git、文本、图片和 PDF 预览 |
| [存储管理](storage.md) | 扫描、保护范围与删除 |
| [架构](architecture.md) | SDK、宿主、连接与前端目录 |
| [设计规范](design.md) | 配色、布局、控件和动效 |
| [诊断](diagnostics.md) | 页面异常和桌面时间线 |

模型与 MCP 的设置分别见[模型](../models/README.md)和 [MCP](../mcp/README.md)。通用模块设置沿用[配置分层](../runtime/configuration.md)。

## SDK 更新日志

应用从随包分发的 SDK `CHANGELOG.md` 读取更新日志，在首次打开空会话时展示。已读状态使用 `settings.json.lastChangelogVersion`，与 TUI 共用。首次使用只建立版本基线，实际展示后才更新已读版本。

`collapseChangelog: true` 默认折叠正文，`quietStartup` 不影响日志展示。

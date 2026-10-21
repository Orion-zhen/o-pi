# LSP

LSP 为 `read`、`grep`、`write` 和 `edit` 提供内部增强。服务器按文件工具调用按需启动，语言服务器需要安装在后端电脑上。

## 命令

| 命令 | 行为 |
| --- | --- |
| `/lsp`、`/lsp status` | 配置路径、服务器状态和最后错误 |
| `/lsp reload` | 关闭连接、清空诊断，后续调用重新连接 |
| `/lsp diagnostics [path]` | 显示工作区或指定文件的已知诊断 |

GUI“设置 → 工具与代码 → LSP 服务器”检查已保存配置中的命令是否位于 PATH，打开页面不会启动服务器。

## 工具增强

| 工具 | 增强 |
| --- | --- |
| read | 局部读取的包围符号、截断后的剩余大纲 |
| grep | 符号结构、引用、调用关系与定义导航 |
| write、edit | 修改后的诊断和可用修复提示 |

有效 LSP 范围优先，Tree-sitter 补充缺失结构。服务器或单项能力不可用时，保留基础文件操作与其他可用结果。

读取大纲预算由文件工具的 `limits.read_outline_symbols` 控制。关系与诊断的完整行为见[协议与增强](protocol.md)。

## 专题

- [配置](configuration.md)：服务器、语言选择器、合并和参数。
- [协议与增强](protocol.md)：同步、诊断、分析与连接生命周期。

实现位于 `src/harness/lsp/`，文件工具适配位于 `src/harness/file-tools/pi/lsp.ts`。

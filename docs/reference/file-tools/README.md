# 文件工具

| 工具 | 用途 |
| --- | --- |
| [ls](ls.md) | 列出目录直属成员 |
| [find](find.md) | 按名称和路径模糊查找文件、目录 |
| [grep](grep.md) | 搜索正文，返回文本行或代码区域 |
| [read](read.md) | 读取 UTF-8 文本、图片和 PDF 页面 |
| [write](write.md) | 创建或完整覆盖文件 |
| [edit](edit.md) | 对已读取或写入的文件执行精确替换 |

## 常见流程

```text
探索目录：ls → find → read
查找实现：grep → read
局部修改：read → edit
创建文件：write → edit
```

明确知道目标时直接读取。`edit` 使用当前会话记录的版本，成功的 `write` 和 `edit` 也会更新该记录。

## 路径与可见性

相对路径基于当前工作目录。工作区外的绝对路径可以显式访问，仍受文件策略和操作系统权限限制。

软忽略路径在自动发现时跳过，明确路径仍可访问。受阻路径拒绝列出、搜索、读取和修改。明确路径可使用符号链接，递归搜索不跟随子符号链接。

已加载技能通过 `skill://` 访问，授权与当前分支的技能记录关联。详见[路径与安全](path-security.md)、[忽略规则](ignore.md)和[技能](../skill-context/README.md)。

## 输出与恢复

模型接收紧凑文本或图片，完整结构保存在 `details`。读取截断后使用 `continuation.lines` 或 `continuation.pages` 续读。搜索截断后按导航缩小范围。

| 错误 | 处理 |
| --- | --- |
| `READ_REQUIRED` | 先读取文件 |
| `STALE_READ` | 重新读取外部变更后的内容 |
| `OLD_TEXT_NOT_UNIQUE` | 使用唯一上下文 |
| `OLD_TEXT_NOT_FOUND` | 检查原文和替换依赖，采用提示或重新读取 |
| `EDIT_VALIDATION_FAILED` | 一次修正全部替换错误 |
| `CONFIG_ERROR` | 修复配置文件 |

公共字段和错误见[工具契约](contracts.md)。

## 配置与实现

- [配置](configuration.md)：预算、路径策略和缓存。
- [架构](architecture.md)：文件系统、调用、版本与生命周期。
- [排序](ranking.md)：fzf、结构证据、BM25F 和候选选择。
- [LSP](../lsp/README.md)：符号、关系与修改后诊断。
- [性能基准](../runtime/benchmark.md)：测量与对比方法。

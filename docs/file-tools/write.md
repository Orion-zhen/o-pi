# `write`

`write` 创建或完整覆盖一个 UTF-8 文件，并自动创建缺失的父目录。

## 参数

```json
{
  "path": "src/new-file.ts",
  "content": "export const value = 1;\n"
}
```

- `path` 可以是相对或绝对路径。
- 文件不存在时创建。
- 文件存在时完整覆盖。
- 内容使用 UTF-8 编码写入。
- 不要求先 `read`。

## 安全、队列与状态

软忽略规则不阻止 `write`，但 `blocked_path` 会拒绝写入。文件系统修改服务会在规范目标专属队列中重新解析并检查以下路径：

- 目标的字面路径
- 最近一个已存在父目录的真实路径
- 已存在目标文件的真实路径

这些检查可防止通过排队期间发生变化的符号链接或符号链接父目录绕过保护。该服务还负责创建父目录、检查快照上限和完整覆盖文件。

修改服务只保证同一进程内对同一目标串行执行，并在提交前检查状态。修改服务不提供跨进程锁、事务、回滚或自动合并。提交时先写入同目录临时文件，再通过重命名原子替换目标。提交成功后，回调会记录当前会话的观测状态，因此随后可以直接调用 `edit`。如果外部进程再次修改文件，`edit` 仍会返回 `STALE_READ`。

写入后的差异保存在 `details.diff`，TUI 只在展开态展示。模型可见成功结果只确认写入路径：

```xml
<write path="src/a.ts"/>
```

## LSP 诊断

只有实际得到 LSP 诊断时才增加状态：

```xml
<write path="src/a.ts" lsp="clean"/>
```

如果存在错误或警告，最多附加 5 条诊断，剩余内容用计数省略：

```xml
<write path="src/a.ts" lsp="errors">
errors=2 warnings=1 new_errors=1 new_warnings=0
diag error 12:5 Cannot find name 'foo'. (TS2304)
diag warning 30:7 'bar' is declared but never used.
... 4 more diagnostics
</write>
```

`write` 专属端口会尽力提供 LSP 诊断。提交前取消不会写入。一旦提交，端口失败或取消不能回滚文件，也不能把成功结果改为失败。现有文件快照和新内容均受 `write_max_file_bytes` 限制。超限返回 `OUTPUT_LIMIT_EXCEEDED`，不会修改目标。

## 失败结果与模型输出

失败总是返回紧凑的 XML。`path`、字段名和路径保护详情保留在 `details`：

```xml
<error>
File could not be written.
</error>
```

常见失败及正文：

| code | 模型正文 |
| --- | --- |
| `INVALID_OPERATION` | `write input must be an object.`、`Unsupported write field: ...`、`path must be a string.` 或 `content must be a string.` |
| `INVALID_PATH` | `Target must be a file path, not the current directory.`、`Parent path cannot be resolved.` 或 `Parent path cannot be created.` |
| `PROTECTED_PATH` | `Path is blocked by file-tools config.` |
| `ACCESS_DENIED` | `Parent path cannot be accessed.` 或 `File could not be written.` |
| `OUTPUT_LIMIT_EXCEEDED` | `File exceeds the configured byte limit.` |
| `OPERATION_ABORTED` | `Operation aborted.` |
| `CONFIG_ERROR` | 配置错误消息 |

写入失败不会创建或覆盖目标文件。但是，如果失败发生在创建父目录之后，已创建的目录可能保留。临时文件清理失败时，临时文件也可能保留。`next:` 只有错误提供恢复建议时才出现。公共修改和错误协议见[工具契约](contracts.md)。

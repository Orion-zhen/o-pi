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
- 内容按普通 UTF-8 文件写入。
- 不要求先 `read`。

## 安全、队列与状态

soft ignore 不阻止 `write`；`blocked_path` 会拒绝写入。filesystem mutation service 在 per-canonical-target queue 内重新解析并检查目标 lexical path、最近已存在父目录 realpath，以及已存在目标文件 realpath，避免通过排队期间变化的 symlink 或 symlink parent 绕过保护。父目录创建、snapshot 上限和 full overwrite 都由该 service 执行。

mutation 只承诺同进程同目标串行和提交前检查，不提供跨进程事务、回滚或自动 merge，也不因重构改为临时 rename 语义。成功 commit callback 会记录 session observation，因此随后可以直接 `edit`；若外部进程再次修改文件，`edit` 仍返回 `STALE_READ`。

写入后的 diff 保存在 `details.diff`，TUI 只在展开态展示；模型可见成功结果只确认写入路径：

```xml
<write path="src/a.ts"/>
```

## LSP diagnostics

只有实际得到 LSP 诊断时才增加状态：

```xml
<write path="src/a.ts" lsp="clean"/>
```

如果存在 errors 或 warnings，最多附加 5 条诊断，剩余内容用计数省略：

```xml
<write path="src/a.ts" lsp="errors">
errors=2 warnings=1 new_errors=1 new_warnings=0
diag error 12:5 Cannot find name 'foo'. (TS2304)
diag warning 30:7 'bar' is declared but never used.
... 4 more diagnostics
</write>
```

LSP diagnostics 是 write-local best-effort port。提交前取消不会写入；一旦提交，port 失败或取消不能回滚文件，也不能把结果改成失败。已有文件 snapshot 和新内容均受 `write_max_file_bytes` 限制；超限返回 `OUTPUT_LIMIT_EXCEEDED`，不会修改目标。

## 失败结果与模型输出

失败总是返回紧凑 XML；`path`、字段名和路径保护详情保留在 `details`：

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

写入失败不会创建或覆盖目标文件；`next:` 只有错误提供恢复建议时才出现。公共 mutation 和错误协议见 [工具契约](contracts.md)。

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

## 安全与状态

soft ignore 不阻止 `write`；`blocked_path` 会拒绝写入。写入前检查目标 lexical path、最近已存在父目录 realpath，以及已存在目标文件 realpath，避免通过 symlink 或 symlink parent 绕过保护。

`write` 与 Pi 内置写入机制一致，不提供事务或回滚，也不更新 `read` 的版本缓存。

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

LSP 失败时写入本身不会因此失败。公共 mutation 和错误协议见 [工具契约](contracts.md)。

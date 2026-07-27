# `edit`

`edit` 只修改一个已存在的 UTF-8 文件，不创建、删除、移动或完整替换文件，不接受 patch/diff DSL。

## 参数

```json
{
  "path": "src/main.ts",
  "edits": [
    { "old": "runOld();", "new": "runNew();" }
  ]
}
```

规则：

- 文件必须存在，且当前 session 必须已有显式 `read`、成功 `write` 或成功 `edit` observation；
- `edits` 非空；
- 每个 `old` 必须非空且在原文件中唯一；
- 所有 replacement 都针对调用开始时的原始文件匹配；
- 替换范围不得重叠；
- 一次调用只能编辑一个文件，但可以修改多个位置。

相邻或重叠修改应合并成一个 `old/new`，不能依赖前一个 replacement 的结果作为下一个 replacement 的输入。

## 版本校验

`read` 会在当前 session 记录原始文件版本，成功 `write/edit` 的 filesystem commit callback 也会记录新版本。`edit` 在 canonical target mutation queue 内读取 current snapshot 后查询并校验 observation：

- 未读过：返回 `READ_REQUIRED`；
- 文件在读取后发生变化：返回 `STALE_READ`；
- replacement 不唯一或旧文本不存在：返回 `OLD_TEXT_*`。
- `OLD_TEXT_NOT_UNIQUE` 会返回前若干个最短唯一 `old/new` replacement，可直接重试；
- `OLD_TEXT_NOT_FOUND` 保持严格匹配，但会依次诊断前序 replacement 依赖、唯一格式等价候选和基于稳定 anchor 的邻近候选；候选数量受 `limits.edit_match_hint_limit` 限制。

这些错误不会自动修正、合并或覆盖文件。前序依赖应改写为全部针对原文的 replacement，或合并依赖修改；格式候选可直接复制为 `old`，并按需调整 `new`；anchor 候选只提供局部上下文，无法确认时按 `error.next` 重新 `read`。

soft ignore 不阻止 `edit`。是否修改只由 filesystem access policy、文件类型、session observation 和 replacement 合法性决定。queue 内会重新检查 blocked/symlink/parent identity；原文件 snapshot 和替换后的提交内容均受 `edit_max_file_bytes` 限制。提交前取消或超限不会修改目标。

## 预览与结果

TUI 在参数完整后可以执行只读预览，call 区只在展开态显示 diff；真正执行仍必须经过 read-before-edit 和版本校验。

成功结果的 diff 是 Pi TUI 使用的精简行号 diff，`firstChangedLine` 保存首个变更行号；模型可见正文只确认修改事实：

```xml
<edit path="src/main.ts" replacements="2" first_changed_line="81"/>
```

成功正文不包含版本字段或完整 diff。diff、before/after LSP diagnostics 和 Repo Map mutation observer 通过 edit-local ports 组合；提交后的 port 失败或取消安全降级，不能回滚或覆盖成功结果。preview 只读取 queue 外的当前 snapshot，不写 observation，也不承诺保留到真正 execute。

重复匹配时，模型可见错误保持紧凑：

```text
edits[0].old matched 6 locations, 3 shown.
line 10 old="..." new="..."
line 24 old="..." new="..."
next: Retry with one shown old/new pair; read only if the file changed.
```

`old` 是原始 `old` 加上的最短唯一上下文，`new` 是对应的完整 replacement。

### `OLD_TEXT_NOT_FOUND` 模型输出

诊断为依赖前序 replacement：

```xml
<error>
edits[1].old is absent from the original file, but appears after edits[0].
next: Rewrite edits[1] against the original content, or merge the dependent changes into one replacement.
</error>
```

归一化后存在唯一格式等价候选：

```xml
<error>
edits[0].old was not found exactly; one formatting-equivalent candidate exists.
line 4 old="if (a &lt; b) {\r\n\tcall();\r\n}"
next: Retry with the shown old text, adapting new if needed; read only if the file changed.
</error>
```

找到基于稳定 anchor 排序的邻近候选：

```xml
<error>
edits[0].old was not found in the original file; 2 nearby candidates shown.
near line 9 text="before\ntargetHandler();\nafter\n"
near line 24 text="before\notherHandler();\nafter\n"
next: Rewrite edits[0].old using a matching candidate, or read the file if none is correct.
</error>
```

没有可靠候选：

```xml
<error>
edits[0].old was not found in the original file.
next: Refine your edit and try again.
</error>
```

格式归一化只覆盖换行符、行尾空格、缩进、连续水平空白和单个首尾边界行，不改变 replacement 的严格匹配与写入语义。anchor 通过最长非空行和低频 identifier/string 定位，并只比较附近若干行，不对全文计算编辑距离。格式等价候选使用 `line N old="..."`，anchor 邻近片段使用 `near line N text="..."`；anchor 返回数量受 `limits.edit_match_hint_limit` 限制。公共协议见 [工具契约](contracts.md)。

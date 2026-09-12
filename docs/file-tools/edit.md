# `edit`

`edit` 只局部修改一个现有的 UTF-8 文件。它不能创建、删除、移动或完整覆盖文件，也不接受补丁或差异描述语言。

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

- 文件必须存在。当前会话必须已通过明确调用 `read` 建立观测状态，或已成功执行 `write` 或 `edit`。
- `edits` 非空。
- 每个 `old` 必须非空，并且在原文件中只出现一次。设置 `replace_all: true` 时替换全部精确匹配。
- 所有替换都以修改队列读取的当前原文为匹配对象。
- 替换范围不得重叠。
- 一次调用只能编辑一个文件，但可以修改多个位置。

相邻或重叠修改应合并成一个 `old/new` 替换，不能依赖前一个替换的结果作为下一个替换的输入。

## 版本校验

`read` 会在当前会话记录原始文件版本。成功的 `write` 或 `edit` 也会通过文件系统提交回调记录新版本。执行 `/reload` 会在同一会话中保存并恢复观测状态。恢复后的文件仍按内容版本校验。当前会话发起的 `bash` 调用会建立命令变更作用域。系统在命令前后重新计算已观察文件的版本，并采纳命令期间产生的变更。命令开始前已经 stale 的文件不会被采纳。`edit` 在规范目标的修改队列中读取当前快照，再查询并校验观测状态：

- 未读过：返回 `READ_REQUIRED`。
- 文件在读取后发生未被当前会话采纳的变化：返回 `STALE_READ`。
- 替换文本不唯一或旧文本不存在：返回 `OLD_TEXT_*`。
- `OLD_TEXT_NOT_UNIQUE` 会返回有限数量的 `old/new` 替换建议。每个建议都包含可唯一匹配的最短上下文，可直接用于重试。
- `OLD_TEXT_NOT_FOUND` 保持严格匹配，但会依次诊断前序替换依赖、唯一格式等价候选和基于稳定锚点的邻近候选。候选数量受 `limits.edit_match_hint_limit` 限制。

验证会检查全部替换，缺失或歧义匹配不会阻止发现其他独立错误。歧义匹配不参与重叠检查，以免产生连带错误。只有全部替换验证通过才写入。

存在多个错误时，返回 `EDIT_VALIDATION_FAILED`，`error.errors` 最多保存 8 个错误，`error.details.total_errors` 记录总数。全部错误共享 `edit_match_hint_limit` 恢复候选预算，包括格式等价候选。只有一个错误时直接返回对应的具体错误。预览与实际执行使用相同验证。模型正文末尾只展示去重后的恢复动作。

```text
3 edit errors, 3 shown. No changes applied.
edits[0].old was not found in the original file.
edits[1].old matched 2 locations, 1 shown.
line 10 old="..." new="..."
edits[2] and edits[3] overlap.
next: Refine your edit and try again.
next: Retry with one shown old/new pair; read only if the file changed.
next: Merge overlapping replacements against the original content.
```

这些错误不会触发自动修正、合并或覆盖。存在前序依赖时，应将所有替换改写为匹配原文，或合并相互依赖的修改。格式候选可直接复制为 `old`，再按需调整 `new`。锚点候选只提供局部上下文。无法确认候选时，应按 `error.next` 重新调用 `read`。

软忽略规则不阻止 `edit`。是否修改只由文件系统访问策略、文件类型、会话观测状态和替换合法性决定。队列中会重新检查受阻路径、符号链接和父目录身份。原文件快照和替换后的提交内容均受 `edit_max_file_bytes` 限制。提交前取消或超限不会修改目标。

## 预览与结果

参数完整后，TUI 可以执行只读预览。调用区域只在展开状态显示差异。实际修改仍须通过先读后改和版本校验。

成功结果包含供 Pi TUI 使用的精简行号差异，`firstChangedLine` 记录首个变更行号。没有可见诊断时，模型正文只确认修改已完成，不报告 `clean` 或已修复计数：

```xml
<edit path="src/main.ts" replacements="2" first_changed_line="81"/>
```

成功正文不包含版本字段或完整差异。取得最新诊断后，展示当前文件的错误总数和有界错误清单。新增错误优先，原有错误标记为 `existing`，基线未知时标记 `causality uncertain`。警告仍只展示修改范围内的新增问题。条数受 `diagnostics.max_items` 限制，超出部分以数量省略：

```text
errors=3
new error at line 18: Argument type mismatch.
existing error at line 42: Cannot find name 'foo'.
... 1 more diagnostics
```

没有诊断结果时不推断错误已经消失。超时或不可用分别返回 `diag timeout` 或 `diag unavailable`。可见错误可以附加唯一、已解析的单文件 quickfix 标题，格式为 `hint: ...`。原有错误不重复请求修复提示。提示不修改文件，不执行命令。

服务器的本次拉取诊断若返回关联文件报告，还可以附加最多 3 个其他文件的错误，与当前文件共用 `diagnostics.max_items` 上限。同源基线已知时只展示新增错误，否则标记 `causality uncertain`。关联文件遵循受阻路径、忽略规则和符号链接边界。同批次已修改文件不重复列为关联文件。

```text
related new error src/caller.ts:27:5: Argument type mismatch.
related error (causality uncertain) src/other.ts:18:3: Missing argument.
```

这不是全工作区检查，也不证明编辑是新增错误的唯一原因。服务器没有返回关联报告时，不额外扫描依赖文件。

`edit` 专属端口负责组合完整差异和修改前后的 LSP 诊断。提交后，端口失败或取消会被忽略，不能回滚修改或把成功结果改为失败。预览只读取队列外的当前快照，不写入观测状态，也不保证内容在实际执行前保持不变。

重复匹配时，模型可见错误保持紧凑：

```text
edits[0].old matched 6 locations, 3 shown.
line 10 old="..." new="..."
line 24 old="..." new="..."
next: Retry with one shown old/new pair; read only if the file changed.
```

`old` 是原始 `old` 加上的最短唯一上下文，`new` 是对应的完整替换。

### `OLD_TEXT_NOT_FOUND` 模型输出

诊断为依赖前序替换：

```xml
<error>
edits[1].old is absent from the original file, but appears after edits[0].
next: Rewrite edits[1] against the original content, or merge the dependent changes into one replacement.
</error>
```

归一化后存在唯一的格式等价候选：

```xml
<error>
edits[0].old was not found exactly; one formatting-equivalent candidate exists.
line 4 old="if (a &lt; b) {\r\n\tcall();\r\n}"
next: Retry with the shown old text, adapting new if needed; read only if the file changed.
</error>
```

找到基于稳定锚点排序的邻近候选：

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

格式归一化只处理换行符、行尾空格、缩进、连续水平空白和单个首尾边界行，不改变严格匹配和写入语义。锚点使用最长非空行、低频标识符或字符串定位。系统只比较锚点附近的若干行，不计算全文编辑距离。格式等价候选使用 `line N old="..."`，锚点邻近片段使用 `near line N text="..."`。锚点返回数量受 `limits.edit_match_hint_limit` 限制。公共协议见[工具契约](contracts.md)。

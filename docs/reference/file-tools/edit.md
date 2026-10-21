# edit

对一个现有 UTF-8 文件执行精确替换。当前会话须已读取该文件，或成功写入过该文件。

## 参数

```json
{
  "path": "src/main.ts",
  "edits": [{ "old": "runOld();", "new": "runNew();" }]
}
```

edits 非空，old 非空且唯一。设置 replace_all 为 true 时替换全部匹配。

所有替换匹配同一份原文，范围不得重叠。需要依赖前一步结果的修改应合并成一次替换。

## 版本

read、write 和 edit 更新会话的文件观测记录，`/reload` 保存并恢复该记录。当前会话的 Bash 可采纳命令期间已观察文件的变化。

edit 进入规范目标队列后读取快照，再检查版本和替换。命令开始前已过期的观测不会由 Bash 更新。

| 错误码 | 处理 |
| --- | --- |
| READ_REQUIRED | 先读取 |
| STALE_READ | 重新读取外部修改后的内容 |
| OLD_TEXT_NOT_UNIQUE | 补充唯一上下文或使用返回候选 |
| OLD_TEXT_NOT_FOUND | 检查原文和替换依赖 |
| EDIT_VALIDATION_FAILED | 修正全部验证错误 |

## 验证与候选

工具检查全部替换，所有验证通过后才写入。多错误使用 EDIT_VALIDATION_FAILED，最多展示 8 项，total_errors 保存总数。

候选共享 `edit_match_hint_limit` 预算：

- 重复匹配提供最短唯一 old/new 上下文。
- 缺失匹配先检查是否依赖前序替换。
- 然后查找唯一格式等价候选与稳定锚点附近片段。

格式归一化用于建议，涵盖换行、行尾空白、缩进和水平空白。实际修改仍使用精确原文。

```text
edits[0].old matched 6 locations, 2 shown.
line 10 old="..." new="..."
line 24 old="..." new="..."
next: Retry with one shown old/new pair; read only if the file changed.
```

候选不足以确认目标时重新读取。

## 提交与结果

队列重新检查受阻路径、符号链接和父目录身份。原文件与新内容均受 edit_max_file_bytes 限制。提交前取消终止写入。

```xml
<edit path="src/main.ts" replacements="2" first_changed_line="81"/>
```

差异保存在 details，界面展开时展示。只读预览使用同一验证逻辑，实际执行仍重新检查快照。

修改后可返回 LSP 诊断。新增错误优先，原有错误标记 existing，未知基线标记 causality uncertain，警告按修改范围内新增情况筛选。可用时附加单文件 quickfix 标题。

关联文档最多展示 3 个，与当前文件共用诊断预算。诊断描述本次服务器结果，失败或超时保留修改成功状态。

公共提交与输出规则见[工具契约](contracts.md)，诊断机制见 [LSP](../lsp/protocol.md)。

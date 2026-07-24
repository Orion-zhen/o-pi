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

- 文件必须存在且必须先显式 `read`；
- `edits` 非空；
- 每个 `old` 必须非空且在原文件中唯一；
- 所有 replacement 都针对调用开始时的原始文件匹配；
- 替换范围不得重叠；
- 一次调用只能编辑一个文件，但可以修改多个位置。

相邻或重叠修改应合并成一个 `old/new`，不能依赖前一个 replacement 的结果作为下一个 replacement 的输入。

## 版本校验

`read` 会在当前 session 记录原始文件版本。`edit` 写入前自动校验该版本：

- 未读过：返回 `READ_REQUIRED`；
- 文件在读取后发生变化：返回 `STALE_READ`；
- replacement 不唯一或旧文本不存在：返回 `OLD_TEXT_*`。

这些错误不会自动合并或覆盖外部修改。应按 `error.next` 重新 `read`，基于最新内容生成新的 replacement。

soft ignore 不阻止 `edit`。是否修改只由文件系统访问结果、文件类型、上次读取版本和 operation 合法性决定。

## 预览与结果

TUI 在参数完整后可以执行只读预览，call 区只在展开态显示 diff；真正执行仍必须经过 read-before-edit 和版本校验。

成功结果的 diff 是 Pi TUI 使用的精简行号 diff，`firstChangedLine` 保存首个变更行号；模型可见正文只确认修改事实：

```xml
<edit path="src/main.ts" replacements="2" first_changed_line="81"/>
```

成功正文不包含版本字段或完整 diff。LSP diagnostics 如有需要由 mutation hook 附加。公共协议见 [工具契约](contracts.md)。

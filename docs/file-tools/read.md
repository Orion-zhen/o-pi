# `read`

`read` 读取明确指定的 UTF-8 文本、普通图片或 PDF。PDF 页面会逐页渲染为图片。`read` 不修改文件，不提取 PDF 文字，也不执行 OCR。读取文件时，`read` 会在会话的 `ObservationStore` 中记录原始字节版本，供后续 `edit` 验证。

## 参数

文本范围：

```json
{
  "path": "src/main.ts",
  "lines": "1-80"
}
```

PDF 页面范围：

```json
{
  "path": "docs/spec.pdf",
  "pages": "2-"
}
```

- `path` 是明确的文件路径。相对路径按当前 `cwd` 解析。
- `lines` 和 `pages` 都接受 `"N"`、`"N-M"` 和 `"N-"`，用逗号组合多个范围，例如 `"1-20,80-100,200-"`。范围从 1 开始，两端均包含。
- 范围不能包含空格、前导零或空起点。终点不能小于起点。
- 先校验全部范围，再按起点排序，合并相邻、重复和重叠范围。同一次调用的全部范围共享输出预算，并来自同一原始字节快照。
- `lines` 和 `pages` 不能同时出现。
- 文本仅接受 `lines`。PDF 仅接受 `pages`。普通图片不接受范围参数。
- 范围终点超过文件行数或 PDF 总页数时，读取到末尾。范围起点超过末尾时返回 `INVALID_PATH`。

## 文本结果

模型可见成功结果是紧凑 XML，完整结构保留在 `details`：

```xml
<read path="src/main.ts" lines="1-80/240" more="81-240">
...content...
</read>
```

文本 `details` 包括：

- `segments`：有序文本片段，每项包含原始 `content`、`start_line`、`end_line` 和可选的 `lsp`。正文不带行号。
- `total_lines`：文件总行数。
- `size_bytes`：原始文件字节数。
- `encoding`：当前固定为 `utf-8`。
- `newline`：`lf`、`crlf`、`mixed` 或 `none`。
- `bom`：是否带 UTF-8 BOM。
- `truncated` 和 `continuation.lines`：输出截断状态和未读范围，可直接作为下次 `lines`。
- `ignored` 和 `ignore_source`：明确读取软忽略文件时的状态。

只有非默认状态才进入模型文本，例如 `ignored`、`bom`、`newline`、`more`、`truncated` 和 LSP 摘要。默认编码、版本和文件大小只保留在 `details`。

多个片段分别标明原始范围，不把间隔内的未读内容当作已返回正文：

```xml
<read path="src/main.ts" lines="1-2,80-81/240" more="82-100,200-240">
<lines range="1-2">
...content...
</lines>
<lines range="80-81">
...content...
</lines>
</read>
```

此时 `continuation.lines` 为 `"82-100,200-240"`。预算耗尽不会丢失后续区间，也不会把区间之间未请求的行加入续读。

## 普通图片结果

`read` 使用 `file-type` 识别二进制文件类型。支持的普通图片以文本说明和 `image` 内容块返回。Base64 不进入文本块：

```ts
[
  { type: "text", text: "Read image file [image/png]" },
  { type: "image", data: "<base64>", mimeType: "image/png" }
]
```

图片会经过格式转换和尺寸限制。转换或缩放提示保存在 `details.hints`，并进入图片前的文本说明。

## PDF 结果

PDF.js 按物理页码顺序渲染选中的页面。每页渲染结果立即进入与普通图片相同的转换和缩放流程。模型内容块顺序固定为：

```ts
[
  { type: "text", text: "<pdf path=\"docs/spec.pdf\" pages=\"2-3/10\" more=\"4-10\" title=\"Spec\" author=\"Example\"/>" },
  { type: "text", text: "<pdf_page number=\"2\" label=\"ii\"/>" },
  { type: "image", data: "<page-2-base64>", mimeType: "image/png" },
  { type: "text", text: "<pdf_page number=\"3\"/>" },
  { type: "image", data: "<page-3-base64>", mimeType: "image/jpeg" }
]
```

摘要包含路径、实际返回页范围、总页数和继续位置。存在标题或作者时，摘要也会包含相应字段。每张图片之前都发送物理页码。PDF 页面标签存在且不同于十进制物理页码时，页面标记还会包含 `label`。页面图片的转换或缩放提示附在对应页面标记中。

PDF `details` 包括：

- `total_pages`：总页数。实际返回页码由 `pages[].number` 表达，模型摘要按连续范围压缩，例如 `pages="2,8-10/20"`。
- `truncated` 和可选的 `continuation.pages`，后者可直接作为下次 `pages`。
- `metadata`：仅保留 `title`、`author`、`subject`、`keywords`、`creator`、`producer`、`creation_date`、`modification_date` 和 `pdf_version`。
- `pages`：每页的物理页码、可选页面标签、点尺寸、旋转角度、处理后的图片和提示。
- `size_bytes` 和根据原始 PDF 字节计算的 `version`。

标题、作者和页面标签属于不可信文档内容。模型格式化会过滤 XML 1.0 禁止的控制字符，按 Unicode 码点限制长度并执行 XML 转义。完整 XMP、自定义 metadata、附件、注释和表单字段不会进入结果。

未指定 `pages` 时，读取从第 1 页开始。一次调用最多返回 `read_pdf_pages` 页，默认值为 20。全部范围共享该限制，重复页只渲染一次。例如 30 页 PDF 首次返回 20 页后，结果包含：

```json
{
  "truncated": true,
  "continuation": { "pages": "21-30" }
}
```

调用方可以使用 `pages: "21-30"` 继续读取。命令只渲染最终选中的页面，不会先渲染完整文档。任一页面解析、渲染或图片处理失败时，整次调用失败，不返回前面页面的部分结果。已打开的 PDF 和页面资源始终释放。

## 图片能力与二进制

PDF 页面和普通图片均作为工具结果中的图片块返回，不按 API 名称禁图。视觉模型使用 `openai-completions` 时，`pi-ai` 在发送请求时把工具图片移到整批工具结果后的临时 `user` 图片消息。`openai-responses` 直接使用工具结果图片。模型声明中没有图片输入能力时，工具结果附加警告。

临时 `user` 图片消息不写回会话历史。`prune` 在请求转换前移除完整工具事务，因此被裁剪的工具图片不会再进入后续请求。撤销裁剪会恢复对应图片，真正的用户图片不受工具裁剪影响。

音频、视频和其他二进制文件返回 `BINARY_FILE_UNSUPPORTED`，错误详情包含识别到的 MIME。目录不会自动列出，`read` 读取目录时返回 `NOT_A_FILE`。

需要密码的加密 PDF 不支持密码参数，并返回结构化的 `BINARY_FILE_UNSUPPORTED`。无效 PDF、页面渲染失败或页面图片无法处理时使用同一错误码，`details` 会指出 PDF 处理阶段和存在时的物理页码。

## 版本、建议与增强

命令通过文件系统内容服务执行有界的稳定读取。路径策略、可见性、`read_max_file_bytes`、版本观测和取消规则对文本、图片和 PDF 原始字节一致生效。即使只请求局部行范围或页面范围，完整文件仍不能超过单文件载入上限。

工作区路径不存在时，`read` 通过 `discovery` 获取候选，再按路径拼写相似度生成建议。候选受受阻路径、可见性、符号链接和条目预算约束。工作区外的路径不提供工作区内路径建议。

只有部分文本读取或截断文本读取会调用 `read` 专属结构端口。每个返回片段分别请求结构，结构提示与正文共享整次调用的预算。如果可见片段未包含最小包围符号的声明行，LSP 会附加包围符号。长文件还可以附加非递归的 `remaining_symbols` 导航信息。LSP 未配置、调用失败或取消时，`read` 仍返回基础文本。PDF 不执行 LSP 结构增强。

当前分支已加载的 `skill://` 路径由文件系统命名空间解析。文本、普通图片和 PDF 结果保留逻辑路径，并附加 `skill_resource`。技能文件不执行工作区 LSP 增强，但会记录供 `edit` 使用的内容版本。

## 限制与错误

- `read_lines` 和 `read_bytes` 在所有片段间共享。结构提示消耗行数和字节预算，分段标记消耗字节预算。外层摘要不计入正文预算。
- `read_pdf_pages` 限制一次返回的 PDF 页面数，默认 20。
- `read_max_file_bytes` 限制文本、图片和 PDF 的原始文件大小。
- 每张普通图片或 PDF 页面图片还受现有内联图片尺寸和 Base64 大小限制。
- 取消在路径解析、原始字节读取、媒体识别、PDF 加载、页面渲染和图片处理边界生效。

常见错误：

| code | 条件 |
| --- | --- |
| `FILE_NOT_FOUND` | 文件不存在 |
| `NOT_A_FILE` | 目标不是普通文件 |
| `INVALID_PATH` | 路径、`lines` 或 `pages` 语法非法，或范围起点越界 |
| `INVALID_OPERATION` | `lines` 与 `pages` 同时出现，或范围参数与媒体类型不匹配 |
| `BINARY_FILE_UNSUPPORTED` | 二进制类型不支持，或 PDF 解析、密码、渲染或页面图片处理失败 |
| `ENCODING_UNSUPPORTED` | 文本不是有效 UTF-8 |
| `PROTECTED_PATH` | 路径被配置阻止 |
| `ACCESS_DENIED` | 无权读取 |
| `OUTPUT_LIMIT_EXCEEDED` | 原始文件或文本输出超过限制 |
| `OPERATION_ABORTED` | 调用被取消 |
| `CONFIG_ERROR` | 文件工具配置无效 |

失败总是返回紧凑 XML。路径、MIME、扩展名和 PDF 失败阶段保留在 `details`：

```xml
<error>
File does not exist.
next: Related paths: src/main.ts
</error>
```

编辑已有文件前，当前会话必须已有观测状态。明确调用 `read`，或成功调用 `write` 或 `edit`，都可以建立观测状态。详见 [edit](edit.md)。

## 非目标

- 不提取 PDF 文字，不执行 OCR，也不为 PDF 文字提供 `lines` 范围。
- 不读取或发送附件、注释、表单字段、完整目录树、完整 XMP 或任意自定义 PDF metadata。
- 不接受 PDF 密码参数。
- 不支持 `"-M"` 或倒序读取。

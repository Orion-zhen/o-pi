# `read`

`read` 读取 UTF-8 文本文件和模型可内联图片文件。它不修改文件、不格式化、不改变换行符，也不写入工作区状态。

## 参数

```json
{
  "path": "src/main.ts",
  "start_line": 1,
  "end_line": 80
}
```

- `path` 是明确的文件路径；相对路径按当前 `cwd` 解析。
- `start_line` 和 `end_line` 为可选行范围。
- `end_line` 超过文件末尾时自动读到文件末尾。
- `start_line` 超过文件末尾返回 `INVALID_PATH`。
- 图片不支持行范围；图片带行范围返回 `INVALID_OPERATION`。

## 文本结果

模型可见成功结果是紧凑 XML，完整结构保留在 `details`：

```xml
<read path="src/main.ts" lines="1-80/240" more="81">
...content...
</read>
```

`details` 包括：

- `content`：原始文本片段，不带行号；
- `start_line` / `end_line` / `total_lines`；
- `size_bytes`：原始文件字节数；
- `encoding`：当前固定为 `utf-8`；
- `newline`：`lf`、`crlf`、`mixed` 或 `none`；
- `bom`：是否带 UTF-8 BOM；
- `truncated` / `continuation`：输出截断时的继续位置；
- `ignored` / `ignore_source`：明确读取 soft ignored 文件时的状态。

只有非默认状态才进入模型文本，例如 `ignored`、`bom`、`newline`、`more`/`truncated` 和 LSP 摘要。默认 encoding、版本和文件大小等内部字段只保留在 `details`。

## 图片与二进制

二进制类型使用 `file-type` 识别。支持的图片作为结构化 `image` content part 返回，不把 base64 当文本：

```ts
[
  { type: "text", text: "Read image file [image/png]" },
  { type: "image", data: "<base64>", mimeType: "image/png" }
]
```

音频、视频和其他二进制文件返回 `BINARY_FILE_UNSUPPORTED`，错误详情包含识别到的 MIME。目录不会自动列出，`read(directory)` 返回 `NOT_A_FILE`。

## 版本与增强

`read` 会在当前 session 记录基于原始字节计算的文件版本，供后续 `edit` 自动校验；版本不进入模型可见输出。

LSP 可以在 partial/truncated read 时附加 enclosing symbol 或 outline；LSP 未配置或失败时仍返回基础内容。

## 限制与错误

`read_lines` 和 `read_bytes` 由 file-tools 配置控制。输出被限制时根据 continuation 读取下一段。

常见错误：

- `FILE_NOT_FOUND`：文件不存在；
- `NOT_A_FILE`：目标不是普通文件；
- `BINARY_FILE_UNSUPPORTED`：不支持的二进制；
- `INVALID_PATH`：路径或行范围非法；
- `PROTECTED_PATH`：命中 blocked path；
- `ACCESS_DENIED`：无权读取。

编辑已有文件时必须先完成一次明确的 `read`，详见 [edit](edit.md)。

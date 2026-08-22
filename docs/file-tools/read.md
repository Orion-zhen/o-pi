# `read`

`read` 读取 UTF-8 文本文件和可向模型内联返回的图片文件。它不会修改或格式化文件，也不会改变换行符。读取工作区文件时，`read` 会在会话的 `ObservationStore` 中记录原始字节版本。读取 Skill 资源时不会记录工作区观测状态。

## 参数

```json
{
  "path": "src/main.ts",
  "start_line": 1,
  "end_line": 80
}
```

- `path` 是明确的文件路径。相对路径按当前 `cwd` 解析。
- `start_line` 和 `end_line` 为可选行范围。
- `end_line` 超过文件末尾时自动读到文件末尾。
- `start_line` 超过文件末尾返回 `INVALID_PATH`。
- 图片不支持行范围。图片带行范围返回 `INVALID_OPERATION`。

## 文本结果

模型可见成功结果是紧凑的 XML，完整结构保留在 `details`：

```xml
<read path="src/main.ts" lines="1-80/240" more="81">
...content...
</read>
```

`details` 包括：

- `content`：原始文本片段，不带行号。
- `start_line` / `end_line` / `total_lines`。
- `size_bytes`：原始文件字节数。
- `encoding`：当前固定为 `utf-8`。
- `newline`：`lf`、`crlf`、`mixed` 或 `none`。
- `bom`：是否带 UTF-8 BOM。
- `truncated` / `continuation`：输出截断时的继续位置。
- `ignored` / `ignore_source`：明确读取软忽略文件时的状态。

只有非默认状态才进入模型文本，例如 `ignored`、`bom`、`newline`、`more`/`truncated` 和 LSP 摘要。默认编码、版本和文件大小等内部字段只保留在 `details`。

## 图片与二进制

`read` 使用 `file-type` 识别二进制文件类型。支持的图片以结构化的 `image` 内容片段返回，不会把 Base64 数据当作文本：

```ts
[
  { type: "text", text: "Read image file [image/png]" },
  { type: "image", data: "<base64>", mimeType: "image/png" }
]
```

音频、视频和其他二进制文件返回 `BINARY_FILE_UNSUPPORTED`，错误详情包含识别到的 MIME。目录不会自动列出，`read(directory)` 返回 `NOT_A_FILE`。

## 版本、建议与增强

命令通过文件系统内容服务执行有界的稳定读取、严格的 UTF-8 校验、BOM 与换行符识别，以及范围切片。命令还会在当前会话记录根据原始字节计算的文件版本，供后续 `edit` 自动校验。版本不进入模型可见输出。明确指定的软忽略文件仍可读取，并带有相应标记。

工作区路径不存在时，文件系统的 `catalog` 服务会生成候选建议。候选受受阻路径、可见性、符号链接和条目预算约束。工作区外的路径不提供工作区内路径建议。

只有部分读取或截断读取会调用 `read` 专属结构端口。如果部分读取未包含最小包围符号的声明行，LSP 会附加包围符号。整文件因长度限制被截断，且可见片段未覆盖大部分顶层声明时，LSP 可以附加非递归的 `remaining_symbols` 导航信息。LSP 未配置、调用失败或取消时，`read` 仍返回基础内容。图片转换通过 `InlineImageProcessor` 端口，`skill://` 在 Pi 适配器边界解析，不进入工作区命名空间。

## 限制与错误

`read_lines` 和 `read_bytes` 控制模型可见输出。输出被截断时，可以根据继续读取位置读取下一段。`read_max_file_bytes` 控制完整文件载入。即使只请求局部行范围，文件超过该上限也会返回 `OUTPUT_LIMIT_EXCEEDED`。取消在路径解析、读取、媒体识别及可选端口边界生效。已打开的句柄由内容服务释放。

常见错误：

- `FILE_NOT_FOUND`：文件不存在。
- `NOT_A_FILE`：目标不是普通文件。
- `BINARY_FILE_UNSUPPORTED`：不支持的二进制。
- `INVALID_PATH`：路径或行范围非法。
- `PROTECTED_PATH`：命中受阻路径。
- `ACCESS_DENIED`：无权读取。
- `OUTPUT_LIMIT_EXCEEDED`：文件超过单文件载入上限。

## 失败结果与模型输出

失败总是返回紧凑的 XML。`path`、MIME、扩展名和版本保留在 `details`：

```xml
<error>
File does not exist.
next: Related paths: src/main.ts
</error>
```

常见失败及正文：

| code | 模型正文 |
| --- | --- |
| `INVALID_PATH` | `Path must not be empty.`、`start_line`/`end_line` 范围校验消息或路径越界消息 |
| `FILE_NOT_FOUND` | `File does not exist.`。工作区内有候选时通过 `next: Related paths: ...` 提示 |
| `NOT_A_FILE` | `Path is not a regular file.` |
| `PROTECTED_PATH` | `Path is blocked by file-tools config.` |
| `ACCESS_DENIED` | `Path cannot be accessed.` |
| `BINARY_FILE_UNSUPPORTED` | `<type> files are not supported by read.` |
| `ENCODING_UNSUPPORTED` | `Only valid UTF-8 text is supported.` |
| `OUTPUT_LIMIT_EXCEEDED` | 单行超过读取输出限制，或文件超过单文件载入上限时返回对应错误消息 |
| `INVALID_OPERATION` | `Line ranges apply only to text files.` |
| `CONFIG_ERROR` | 配置错误消息 |

`next:` 只有错误提供恢复建议时才出现。编辑已有文件前，当前会话必须已有观测状态。明确调用 `read`，或成功调用 `write` 或 `edit`，都可以建立观测状态。详见[edit](edit.md)。

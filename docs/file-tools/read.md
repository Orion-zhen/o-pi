# `read`

`read` 读取 UTF-8 文本文件和模型可内联图片文件。它不修改文件、不格式化、不改变换行符；普通 workspace read 会在 session `ObservationStore` 记录原始字节版本，skill resource 不记录 workspace observation。

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

## 版本、建议与增强

command 通过 filesystem content service 执行 stable bounded read、严格 UTF-8、BOM/newline 与范围切片，并在当前 session 记录基于原始字节计算的文件版本，供后续 `edit` 自动校验；版本不进入模型可见输出。明确 soft ignored 文件仍可读并带 annotation。

缺失 workspace path 先询问 read-local Repo Map suggestion port，再回退到 filesystem path catalog；候选受 blocked、visibility、symlink 与条目预算约束。workspace 外路径不做 workspace 建议。

只有 partial/truncated read 才调用 read-local structure/graph ports；LSP 仅在 partial read 的最小包围 symbol 声明行不可见且 Repo Map 未提供同一事实时附加 enclosing symbol。整文件因长度截断且可见片段不足以覆盖大部分顶层声明时，可附加非递归的 `remaining_symbols` 导航 fallback。LSP/Repo Map 未配置、失败或取消时仍返回基础内容。图片转换通过 `InlineImageProcessor` port，`skill://` 在 Pi adapter 边界解析，不进入 workspace namespace。

## 限制与错误

`read_lines` 和 `read_bytes` 控制模型可见输出，输出被截断时可根据 continuation 读取下一段。`read_max_file_bytes` 控制完整文件载入；即使只请求局部行范围，文件超过该上限也会返回 `OUTPUT_LIMIT_EXCEEDED`。取消在 resolve、读取、媒体识别及可选 port 边界生效；已打开的 handle 由 content service 释放。

常见错误：

- `FILE_NOT_FOUND`：文件不存在；
- `NOT_A_FILE`：目标不是普通文件；
- `BINARY_FILE_UNSUPPORTED`：不支持的二进制；
- `INVALID_PATH`：路径或行范围非法；
- `PROTECTED_PATH`：命中 blocked path；
- `ACCESS_DENIED`：无权读取；
- `OUTPUT_LIMIT_EXCEEDED`：文件超过单文件载入上限。

## 失败结果与模型输出

失败总是返回紧凑 XML；`path`、MIME、扩展名和版本保留在 `details`：

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
| `FILE_NOT_FOUND` | `File does not exist.`；workspace 内有候选时通过 `next: Related paths: ...` 提示 |
| `NOT_A_FILE` | `Path is not a regular file.` |
| `PROTECTED_PATH` | `Path is blocked by file-tools config.` |
| `ACCESS_DENIED` | `Path cannot be accessed.` |
| `BINARY_FILE_UNSUPPORTED` | `<type> files are not supported by read.` |
| `ENCODING_UNSUPPORTED` | `Only valid UTF-8 text is supported.` |
| `OUTPUT_LIMIT_EXCEEDED` | `A single line exceeds the read output limit.` |
| `INVALID_OPERATION` | `Line ranges apply only to text files.` |
| `CONFIG_ERROR` | 配置错误消息 |

`next:` 只有错误提供恢复建议时才出现。编辑已有文件前需要当前 session observation；明确 `read` 或成功 `write/edit` 均可建立，详见 [edit](edit.md)。

# read

读取 UTF-8 文本、图片或 PDF 页面，同时记录文件版本供 edit 使用。PDF 按页渲染为图片。

## 参数

```json
{ "path": "src/main.ts", "lines": "1-80,200-" }
```

```json
{ "path": "docs/spec.pdf", "pages": "2-4" }
```

lines 与 pages 二选一，普通图片省略范围。范围从 1 开始且两端包含，支持 N、N-M、N- 和逗号组合。空格、前导零、倒置范围和空起点非法。

范围先排序、去重并合并相邻区间，全部区间共享预算和同一文件快照。终点超出末尾时裁剪，起点超出末尾时报错。

## 文本

```xml
<read path="src/main.ts" lines="1-80/240" more="81-240">
...content...
</read>
```

多个不连续片段分别标记原范围。details 包含 segments、total_lines、size_bytes、encoding、newline、bom、ignored、truncated 和 continuation.lines。

continuation.lines 保留所有未读请求区间，可直接用于下一次调用。newline、bom 和忽略状态只在需要时进入模型文本。

## 代码结构

局部读取可提示最近具名包围区域，整文件截断可提供剩余大纲。有效 LSP 范围优先，Tree-sitter 补充函数体、嵌套结构和匿名回调。

```xml
<structure enclosing="function inner 5-12"/>
```

匿名回调使用外层具名归属，解析错误与范围冲突保存在 details。结构提示与正文共享字节预算，正文行数预算独立。

`limits.read_outline_symbols` 默认 40，设为 0 关闭剩余大纲。`grep_ast_max_file_bytes` 同时限制读取结构增强大小。完整且未截断读取直接返回正文。

## 图片与 PDF

普通图片经过类型识别和格式、尺寸处理，以文本说明及原生 image 块返回。PDF 按选定物理页顺序返回页码标记和图片：

```xml
<pdf path="docs/spec.pdf" pages="2-3/10" more="4-10"/>
<pdf_page number="2" label="ii"/>
```

每个页标记后跟对应图片块。标签与物理页码不同时保留 label。PDF details 保存总页数、页面信息、选中范围、元数据、文件大小与版本。

默认从第一页开始，每次最多 `read_pdf_pages` 页，默认 20。后续范围由 continuation.pages 返回。任一页面处理失败时整次调用失败，打开的解析与渲染资源会释放。

PDF 通过图片供模型阅读，扫描件也按页面图像处理。加密或损坏文档返回 BINARY_FILE_UNSUPPORTED，details 指明处理阶段。

图片进入历史后由 SDK 处理 API 适配。Chat Completions 将工具图片投影为临时用户图片消息，Responses 使用工具图片。裁剪工具事务也会移除后续请求中的对应图片。

## 预算与路径

| 配置 | 范围 |
| --- | --- |
| read_lines | 所有文本片段的正文行数 |
| read_bytes | 正文、结构提示和分段标记 |
| read_max_file_bytes | 原始文件大小，包括局部读取 |
| read_pdf_pages | 单次 PDF 返回页数 |
| read_suggestion_limit | 缺失路径的建议数量 |

工作区路径不存在时，可以返回受访问策略约束的近似路径。已加载技能通过 skill:// 读取，保留逻辑路径和版本观测。

## 错误

| 错误码 | 含义 |
| --- | --- |
| FILE_NOT_FOUND | 文件不存在 |
| NOT_A_FILE | 目标是目录或其他类型 |
| INVALID_PATH | 路径或范围非法 |
| INVALID_OPERATION | 范围与类型不匹配 |
| BINARY_FILE_UNSUPPORTED | 类型或 PDF 处理不支持 |
| ENCODING_UNSUPPORTED | 文本不是有效 UTF-8 |
| OUTPUT_LIMIT_EXCEEDED | 超过字节限制 |
| PROTECTED_PATH、ACCESS_DENIED | 路径或权限拒绝 |
| OPERATION_ABORTED、CONFIG_ERROR | 取消或配置错误 |

编辑流程见 [edit](edit.md)，公共输出见[工具契约](contracts.md)。

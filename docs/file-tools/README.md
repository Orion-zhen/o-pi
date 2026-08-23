# 文件工具设计

本文概述文件工具的日常用法，包括工具选择、常见安全边界和主要操作。实现细节、完整字段说明和排序算法见文末的专题文档。

## 快速选择工具

| 需求 | 工具 | 关键边界 |
| --- | --- | --- |
| 查看目录 | `ls` | 只列直属成员，不递归、不读文件内容 |
| 按名称或路径模糊搜索文件，或用 glob 筛选候选 | `find` | 不搜索文件正文或代码符号 |
| 按行搜索正文或相关代码区域 | `grep` | 不负责按路径查找文件 |
| 读取明确文件 | `read` | 不会把目录自动转换成目录列表 |
| 创建或完整覆盖文件 | `write` | 不做局部合并 |
| 修改已有文件的局部内容 | `edit` | 必须先 `read`，或紧接当前会话中成功的 `write` 或 `edit`。不创建文件，也不完整覆盖文件 |

常见工作流：

```text
探索仓库：       ls → find → read
查找实现：       grep → read
局部修改：       read → edit
创建后继续修改： write → edit
创建或完整重写： write
```

不要用 `ls` 读取文件，不要用 `find` 搜索内容，也不要用 `grep` 代替完整文件读取。知道目标文件后直接 `read`。需要精确修改已有文件时通常先 `read` 再 `edit`。成功的 `write` 或 `edit` 已记录最新观测状态，可以继续调用 `edit`。

## 总体设计

```text
Pi 扩展
    ↓ 模式、延迟加载适配器、呈现器、遥测
独立的 ls/read/write/edit/find/grep 命令
    ↓ 工具专属端口                 ↑ LSP / Skill / 图片 / PDF / 差异适配器
WorkspaceFileSystem 能力门面
    ↓
命名空间与访问内核 + 可见性、内容、遍历、目录和修改服务
    ↓
Node 平台后端
```

Pi 扩展入口位于 `agent/extensions/file-tools.ts`。六个工具分别位于 `src/file-tools/{ls,read,write,edit,find,grep}/`，互不导入。工具之间只共享错误、诊断、差异和纯排序原语。`src/filesystem/` 是工作区 I/O 的唯一数据平面，不依赖 Pi、模型输出、LSP、Tree-sitter 或具体工具结果。

每次调用都由 `FileToolsHost.open({ cwd, sessionId, signal })` 根据调用的 `cwd` 加载配置。然后，`FileToolsHost` 提供 `WorkspaceFileSystem`、工具预算和会话观测状态。`WorkspaceFileSystem` 绑定不可变策略和仅供本次调用使用的可见性求值器。

可见性求值器复用实际目录枚举，并增量加载忽略规则，不会在打开调用时扫描整个仓库。工具在首次使用时按执行路径延迟加载。不使用文件工具的会话不会加载文件系统运行时。调用 `ls` 也不会加载 `find`、`grep`、修改服务、Tree-sitter 或 LSP。

工具职责保持分离：

- `ls` 只浏览目录直属成员。
- `find` 只定位路径，不读取正文，也不返回文件元数据。对于 `readdir` 已分类的普通文件和目录条目，它使用受策略约束的目录项快照。符号链接和未知类型仍会在递归边界重新验证。
- `grep` 只搜索内容和代码区域，不负责列目录。
- `read` 只读取明确指定的 UTF-8 文本、普通图片或 PDF 页面图片。
- `write` 只创建或完整覆盖。
- `edit` 只对已有文件执行精确替换。

LSP 只提供内部增强，不是额外的模型可见工具。LSP 未配置、超时、失败或可执行文件不存在时，文件工具会退化为基础行为。`ls` 和 `find` 不接入 LSP。

## 常见操作规则

### 路径

相对路径按当前 `cwd` 解析。工作区内的绝对路径以工作区相对路径返回。工作区外的绝对路径保持规范化后的绝对形式。工具不会展开普通文件名中的 glob。

工具允许访问工作区外的路径，但仍受 Pi 进程权限和操作系统权限限制。文件或目录的符号链接可以作为明确路径访问。递归搜索不跟随符号链接。

### 忽略规则与保护路径

忽略规则和访问控制是两个不同概念：

```text
软忽略路径   → 自动发现、递归搜索和索引默认跳过。明确路径仍可访问
受阻路径     → 不可列出、搜索、读取或写入
```

`.piignore` 和 `.gitignore` 默认参与自动发现，但不是访问控制机制。普通点文件不会只因为名称以 `.` 开头就被隐藏。`.git/` 默认是受阻路径。符号链接指向受阻路径时也会被拒绝。

详细规则见[忽略规则引擎](ignore.md)和[路径与安全](path-security.md)。

### 输出、截断和错误

模型可见结果使用紧凑文本或短标签，完整结构保存在工具 `details` 中。目录条目、搜索结果、读取内容和代码片段都有各自的数量或词元限制。`grep` 只按结果条数限制模型输出，并通过 `truncated_by` 暴露遍历、正文字节和结果限制原因。正文命中、相关锚点或 AST 增强的内部容量不作为模型截断原因。

常见恢复方式：

- 目录太大：用 `ls` 查看更具体的子目录。
- `find` 或 `grep` 被截断：缩小 `path`、增加 `glob` 约束或拆分查询。先根据 `truncated_by` 判断具体限制。
- `read` 被截断：文本根据 `continuation.start_line` 继续，PDF 根据 `continuation.start_page` 继续。
- `READ_REQUIRED`：先重新 `read`，再生成 `edit`。
- `STALE_READ`：文件在读取后发生变化，重新 `read` 后再编辑。
- `OLD_TEXT_NOT_UNIQUE`：优先使用错误中返回的唯一 `old/new` 文本对重试。文件变化时再重新 `read`。
- `OLD_TEXT_NOT_FOUND`：按错误提示消除对前序替换的依赖，或使用格式等价候选或锚点候选重写 `old`。没有可靠候选时重新 `read`。
- 无效正则只有在精确字面量存在直接命中时才显式降级。否则，它与路径错误或权限错误一样，不会伪装成零结果。

公共输出和错误协议见[工具契约](contracts.md)。

## 六个工具的行为摘要

### `ls`

`ls` 只列出指定目录的直属成员。不指定路径时列出当前工作区。目录显示为 `name/`，符号链接显示为 `name@ -> target`。被软忽略的条目会带来源标记。默认最多返回 200 个条目，并按类型和名称稳定排序。

### `find`

`find` 对文件和目录路径执行 fzf 扩展搜索，也支持多个搜索根。多个 `path` 表示范围并集。独立的 `glob` 只筛选候选，不从 `query` 推导。普通查询词使用模糊子序列匹配，多个查询词采用 AND 关系。查询还支持精确、边界、前缀、后缀、反向和 OR 操作符。运行时固定使用智能大小写和路径匹配模式，不读取正文，也不解析 AST。

### `grep`

`grep` 对 `query` 执行区分大小写的逐行搜索。合法查询使用 ECMAScript 正则。非法正则只有在精确字面量存在直接正文命中时才返回 `literal_fallback`，否则返回 `INVALID_REGEX`。

对于任意合法查询，`grep` 都会优先尝试完整的 LSP 分析。LSP 事务不可用时，Tree-sitter 会把真实正文命中归入最小代码单元，并根据代码单元之间的关系标记 `called`、`referenced` 或 `defined`。

排序不推断 `src`、`tests` 或夹具等路径的含义。在每个查询层级中，排序优先保留实际参与调用链的定义。`grep_related_result_limit` 限制相关结果数量，但不会在模型输出中提示该限制。剩余结果按结构层级、BM25F 和来源内排名排序。最后，`grep_result_limit` 通过相关性头部和同层级 MMR 限制结果总数。

### `read`

`read` 读取 UTF-8 文本、可向模型内联返回的普通图片和 PDF 页面图片。文本使用 `lines` 范围，PDF 使用 `pages` 范围。PDF 默认一次最多返回 20 页，并通过 `continuation.start_page` 提供继续位置。它不提取 PDF 文字或执行 OCR。音频、视频及其他不支持的二进制文件会返回结构化错误。`read` 还为后续 `edit` 记录当前文件版本。

### `write`

`write` 创建新文件或完整覆盖已有文件，并自动创建缺失的父目录。它不要求先调用 `read`，也不提供事务或回滚。软忽略规则不阻止写入，受阻路径会拒绝写入。

### `edit`

`edit` 一次只修改一个已有的 UTF-8 文件。每个 `old` 文本必须非空且唯一。所有替换都与修改队列读取的当前原文匹配，并且范围不得重叠。当前会话必须已经对文件执行过 `read`、成功的 `write` 或成功的 `edit`，以建立观测状态。版本不一致时不会自动合并或覆盖。

## 配置概览

配置位置：

```text
默认配置：~/.pi/agent/defaults/file-tools.jsonc
用户配置：~/.pi/agent/configs/file-tools.jsonc
项目配置：.pi/configs/file-tools.jsonc
```

项目配置在用户配置之后加载。它可以追加 `blocked_path` 和 `ignored_path`，也可以覆盖 `limits` 和内置忽略档位，但不能关闭用户级 `.piignore`、`.gitignore` 或已跟踪文件绕过策略。

默认行为包括：

- 启用 `.piignore` 和 `.gitignore`。
- 已跟踪文件绕过 `.gitignore`，但不绕过 `.piignore`。
- 默认阻止访问 `.git/`。
- `ls` 最多 200 项。
- `read` 文本最多 3000 行或 51200 字节，PDF 默认一次最多返回 20 页。
- `find` 受共享遍历条目数、范围深度、结果数和模型输出词元预算限制。
- `grep` 受共享遍历条目数、累计正文快照字节数、范围深度、AST 单文件字节数、相关结果数、结果总数和每个区域的展示行数限制。

完整字段、优先级和缓存行为见[配置](configuration.md)。

## 可选增强

- LSP 按需增强各工具。它为 `grep` 提供符号代码单元、引用和传入调用，为 `read` 的文本结果提供结构边界和长文件中的剩余符号导航，为 `write` 和 `edit` 提供诊断。
- PDF.js 和 Canvas 仅在 `read` 实际读取 PDF 时加载。PDF 页面复用普通图片的转换、缩放和模型内联流程。
- 增强失败时仍保留基础文件操作和文本搜索能力。

详见[LSP 内部增强](../lsp.md)。

## 深入阅读

| 主题 | 文档 |
| --- | --- |
| 扩展入口、模块边界和懒加载 | [architecture.md](architecture.md) |
| 配置字段、优先级和缓存 | [configuration.md](configuration.md) |
| 忽略模式、快照和解释信息 | [ignore.md](ignore.md) |
| 路径解析、符号链接和受阻路径 | [path-security.md](path-security.md) |
| 公共输出、错误和提示词契约 | [contracts.md](contracts.md) |
| `ls` 完整行为 | [ls.md](ls.md) |
| `read` 完整行为 | [read.md](read.md) |
| `find` 完整行为 | [find.md](find.md) |
| `grep` 完整行为 | [grep.md](grep.md) |
| `write` 完整行为 | [write.md](write.md) |
| `edit` 完整行为 | [edit.md](edit.md) |
| 搜索排序总览 | [ranking.md](ranking.md) |
| 候选证据和来源排序 | [ranking-evidence.md](ranking-evidence.md) |
| Top-K 选择 | [ranking-selection.md](ranking-selection.md) |
| 性能基准、采样与对比 | [benchmark.md](../benchmark.md) |

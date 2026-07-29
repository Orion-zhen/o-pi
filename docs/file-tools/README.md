# 文件工具设计

这份 README 是面向日常使用的总说明。只读完这里，就应该能够选择正确的工具、理解常见安全边界，并完成大多数浏览、搜索、读取和修改任务。实现细节、完整字段和排序算法见文末的专题文档。

## 快速选择工具

| 需求 | 工具 | 关键边界 |
| --- | --- | --- |
| 查看目录 | `ls` | 只列直属成员，不递归、不读文件内容 |
| 按路径、名称或 glob 找文件 | `find` | 不搜索文件正文或 symbol |
| 搜索正文、symbol、正则或代码意图 | `grep` | 不负责按路径找文件 |
| 读取明确文件 | `read` | 不会把目录自动转换成目录列表 |
| 创建或完整覆盖文件 | `write` | 不做局部合并 |
| 修改已有文件的局部内容 | `edit` | 必须先 `read`，或紧接当前 session 的成功 `write/edit`；不创建、不完整覆盖 |

常见工作流：

```text
探索仓库：       ls → find → read
查找实现：       grep(match=auto) → read
局部修改：       read → edit
创建后继续修改： write → edit
创建或完整重写： write
```

不要用 `ls` 读取文件，不要用 `find` 搜索内容，也不要用 `grep` 代替完整文件读取。知道目标文件后直接 `read`。需要精确修改已有文件时通常先 `read` 再 `edit`；成功 `write` 或 `edit` 已记录最新 observation，可以继续 `edit`。

## 总体设计

```text
Pi extension
    ↓ schema、lazy adapter、renderer、telemetry
独立 ls/read/write/edit/find/grep commands
    ↓ tool-local ports                 ↑ LSP / skill / image / diff adapters
WorkspaceFileSystem capability facade
    ↓
namespace/access kernel + visibility/content/traversal/catalog/mutation services
    ↓
Node platform backend
```

Pi 扩展入口位于 `agent/extensions/file-tools.ts`。六个工具分别位于 `src/file-tools/{ls,read,write,edit,find,grep}/`，互不导入；共享内容只限错误、diagnostics、diff 和纯 ranking primitives。`src/filesystem/` 是 workspace I/O 的唯一数据平面，不知道 Pi、模型输出、LSP、Tree-sitter 或具体工具结果。

每次调用由 `FileToolsHost.open({ cwd, sessionId, signal })` 先按 invocation `cwd` 加载配置，再提供绑定不可变 policy/visibility snapshot 的 `WorkspaceFileSystem`、工具预算和 session observation。工具在首次使用时按执行路径懒加载；不使用文件工具的 session 不加载 filesystem runtime，`ls` 也不会加载 find/grep、mutation service、Tree-sitter 或 LSP。

工具职责保持分离：

- `ls` 只浏览目录直属成员。
- `find` 只定位路径，不读取正文。
- `grep` 只搜索内容和代码区域，不负责列目录。
- `read` 只读取明确文件或支持的图片。
- `write` 只创建或完整覆盖。
- `edit` 只对已有文件做 exact replacement。

LSP 是内部增强，不是额外的模型可见工具。它未配置、超时、失败或 binary 不存在时，文件工具退化为基础行为；`ls` 和 `find` 不接入 LSP。

## 常见操作规则

### 路径

相对路径按当前 `cwd` 解析；workspace 内绝对路径以 workspace-relative path 返回，workspace 外路径保持规范化后的相对或绝对形式。工具不会展开普通文件名中的 glob。

工具允许访问 workspace 外路径，但最终仍受 Pi 进程和操作系统权限限制。文件或目录 symlink 本身可以作为明确路径访问；递归搜索不跟随 symlink。

### Ignore 与保护路径

ignore 和访问控制是两个不同概念：

```text
soft ignored  → 自动发现、递归搜索和索引默认跳过；明确路径仍可访问
blocked path  → 不可列出、搜索、读取或写入
```

`.piignore` 和 `.gitignore` 默认参与自动发现，但不是访问控制机制。普通 dotfile 不会因为以 `.` 开头就自动隐藏；`.git/` 默认是 blocked path。symlink 指向 blocked path 时也会被拒绝。

详细规则见 [Ignore engine](ignore.md) 和 [路径与安全](path-security.md)。

### 输出、截断和错误

模型可见结果使用紧凑文本或短标签，完整结构保存在工具 `details` 中。目录条目、搜索结果、读取内容和代码片段都有数量或 token 限制；`grep` 通过 `truncated_by` 暴露遍历、正文字节、语义候选、结果和 token 原因，不把多种限制合并成一个布尔字段。

常见恢复方式：

- 目录太大：用 `ls` 查看更具体的子目录。
- `find` 或 `grep` 被截断：缩小 `path`、增加 glob 约束或拆分查询；先根据 `truncated_by` 判断是遍历、正文、语义、结果还是 token 限制。
- `read` 被截断：根据 continuation 读取下一段。
- `READ_REQUIRED`：先重新 `read`，再生成 `edit`。
- `STALE_READ`：文件在读取后发生变化，重新 `read` 后再编辑。
- `OLD_TEXT_NOT_UNIQUE`：优先使用错误中返回的唯一 `old/new` pair 重试；文件变化时再重新 `read`。
- `OLD_TEXT_NOT_FOUND`：按错误提示消除前序 replacement 依赖，或使用格式等价/anchor 候选重写 `old`；没有可靠候选时重新 `read`。
- 无效正则、路径错误和权限错误不会伪装成零结果。

公共输出和错误协议见 [工具契约](contracts.md)。

## 六个工具的行为摘要

### `ls`

`ls` 只列指定目录的直属成员；不指定路径时列当前 workspace。目录用 `name/` 展示，symlink 用 `name@ -> target` 展示，soft ignored entry 会带来源标记。默认最多返回 200 个可见条目，并按类型和名称稳定排序。

### `find`

`find` 支持精确路径、文件名、路径片段和 glob，也支持多个搜索根。多个 `path` 是 OR/union scope，不是 AND。glob 进入严格路径匹配；普通查询按路径召回和排序。它不会读取正文或解析 AST。

### `grep`

`grep` 支持 `auto`、`literal` 和 `regex`。`auto` 先使用实时正文和 Tree-sitter；只有精确符号有歧义或关系结果不足时，才用可选 LSP 提示选择 live AST 位置。`literal` 和 `regex` 不调用 LSP。结果按函数、方法、类、声明或紧凑文本区域聚合，而不是简单返回每一行。

### `read`

`read` 读取 UTF-8 文本和模型可内联图片，支持行范围。它保留原始内容和换行，不格式化文件。音频、视频及其他不支持的二进制文件会返回结构化错误。`read` 还为后续 `edit` 记录当前文件版本。

### `write`

`write` 创建新文件或完整覆盖已有文件，并自动创建缺失的父目录。它不要求先 `read`，也不提供事务或回滚。soft ignore 不阻止写入，blocked path 会拒绝写入。

### `edit`

`edit` 一次只修改一个已有 UTF-8 文件。每个 `old` 文本必须非空且唯一，所有 replacement 都针对 mutation queue 内读取的当前原文匹配，范围不得重叠。文件必须有当前 session 的 `read`、成功 `write` 或成功 `edit` observation；版本不一致时不会自动合并或覆盖。

## 配置概览

配置位置：

```text
默认配置：~/.pi/agent/defaults/file-tools.jsonc
用户配置：~/.pi/agent/configs/file-tools.jsonc
项目配置：.pi/configs/file-tools.jsonc
```

项目配置在用户配置之后加载，可以追加 `blocked_path`、`ignored_path`，覆盖 `limits` 和 builtin ignore profile，但不能关闭用户级 `.piignore`、`.gitignore` 或 tracked-file bypass 策略。

默认行为包括：

- 启用 `.piignore` 和 `.gitignore`。
- 已 tracked 文件绕过 `.gitignore`，但不绕过 `.piignore`。
- 默认 blocked `.git/`。
- `ls` 最多 200 项。
- `read` 最多 2000 行或 51200 字节。
- `find` 受 scope 深度、结果数和模型输出 token budget 限制；`grep` 只配置 scope 深度、AST 单文件字节、结果条数和模型输出 token budget，正文事实扫描不受旧文件数/累计字节/单文件字节字段限制。

完整字段、优先级和缓存行为见 [配置](configuration.md)。

## 可选增强

- LSP 为 `grep` 按需提供位置消歧，为 `read` 提供结构边界与长文件剩余 symbol 导航，并为 `write`/`edit` 提供 diagnostics。
- 增强失败时仍保留基础文件操作和文本搜索能力。

详见 [LSP 内部增强](../lsp.md)。

## 深入阅读

| 主题 | 文档 |
| --- | --- |
| 扩展入口、模块边界和懒加载 | [architecture.md](architecture.md) |
| 配置字段、优先级和缓存 | [configuration.md](configuration.md) |
| ignore pattern、snapshot 和 explain | [ignore.md](ignore.md) |
| 路径解析、symlink 和 blocked path | [path-security.md](path-security.md) |
| 阶段 1 public contract 与可执行基线 | [baseline.md](baseline.md) |
| 公共输出、错误和 prompt 契约 | [contracts.md](contracts.md) |
| `ls` 完整行为 | [ls.md](ls.md) |
| `read` 完整行为 | [read.md](read.md) |
| `find` 完整行为 | [find.md](find.md) |
| `grep` 完整行为 | [grep.md](grep.md) |
| `write` 完整行为 | [write.md](write.md) |
| `edit` 完整行为 | [edit.md](edit.md) |
| 搜索排序总览 | [ranking.md](ranking.md) |
| 证据融合和来源排序 | [ranking-evidence.md](ranking-evidence.md) |
| Top-K、MMR 和 nearby | [ranking-selection.md](ranking-selection.md) |
| lazy loading、缓存和 benchmark | [performance.md](performance.md) |

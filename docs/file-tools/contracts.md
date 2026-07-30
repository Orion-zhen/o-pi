# 工具契约

本文说明六个文件工具共享的参数、模型输出、错误和提示词约定。各工具的字段细节见 [工具文档](README.md#深入阅读)。

## Filesystem capability 边界

工具只依赖 `WorkspaceFileSystem` 的分组 capability：`paths`、`metadata`、`content`、`visibility`、`traversal`、`discovery`、`mutations` 和 `catalog`。路径解析返回 opaque ref，后续操作不重新接受裸 native path。每个 invocation 绑定 workspace identity、不可变 policy、invocation-local visibility state 和 operation context。

filesystem discovery 组合 namespace、visibility、metadata 与 traversal，统一解释 scope-relative glob、静态前缀剪枝、原始 scope 深度、显式 ignored root/静态前缀和 child symlink。每个文件 entry 携带必填 object identity、version 与 size snapshot；`content` 的 `expectedSnapshot` 约束打开的文件必须等于调用方捕获版本，`stable` 则检测读取期间的变化，两者职责独立。

filesystem 失败使用模型无关的 `FsResult` 与稳定 `FsError` code；tool command 在边界映射为既有 `FileToolError`，Pi presenter 再生成模型文本。snapshot 不匹配和读取期间变化统一为 `changed-during-read`。filesystem error 不含工具名、`next`、模型文案或 LSP 数据。合法零搜索结果仍是成功，不能与 I/O、配置、取消或索引失败混淆。

配置先于 workspace I/O 加载。项目配置始终按 Pi invocation 的 `ctx.cwd` 选择，不隐式读取 `process.cwd()`；配置错误直接返回 `CONFIG_ERROR`。

## 输入约定

路径参数按工具语义分为单路径和多路径：

- `ls`、`read`、`write`、`edit` 接受一个明确路径。
- `find`、`grep` 的 `path` 是非空数组，多个 scope 表示 OR/union，不是 AND。
- 相对路径按当前 `cwd` 解析；空路径、空数组和空元素非法。
- `find` 和 `grep` 的旧单路径或分隔字符串由 `tool-repair` 迁移；无法可靠解析时交给 schema 校验失败，不猜测真实路径。

`find` 的 `query` 是 fzf extended-search query，`glob` 是独立的候选预筛选，永远不从 query 推断。find 固定使用 smart case 和 path scheme。`grep` 的 `query` 区分大小写并逐行执行；合法 query 使用 ECMAScript 正则，非法正则只在 exact literal 有直接正文命中时返回显式 `literal_fallback`，否则保持 `INVALID_REGEX`。两个搜索工具的 glob 都由 filesystem discovery 相对每个 scope 解释，只限制候选范围，不改变公共路径安全规则。

## 模型可见结果

工具成功结果优先使用紧凑文本，完整结构保留在 `details`。模型可见的自生成标签、属性、标点和分隔符使用紧凑 ASCII；文件名、源码、诊断、shell 输出和网页等原始 payload 保留 Unicode。

默认或内部字段，例如 `encoding: utf-8`、`bom: false`、版本、fingerprint 和完整 diff，通常只进入 `details`。只有会改变下一步操作的状态才进入模型文本，例如：

- `ignored`；
- `truncated` 或 continuation；
- 搜索深度或结果限制；
- LSP diagnostics 摘要；
- `find` 的截断原因和部分 scope 错误；

TUI 展示不受模型可见 ASCII 协议限制，可以使用图标和其他显示字符。

## 输出预算

`ls`、`read`、`find` 和 `grep` 都有各自的输出限制：

- `ls` 限制直属 entry 数；
- `read` 限制行数和字节数；
- `find` 配置 scope 深度、具体结果和模型文本；
- `grep` 配置 scope 深度、AST 单文件增强字节、related 数、每区域展示行和总结果条数；模型文本不设 token budget，正文扫描本身使用 filesystem line stream。

预算不足时，输出必须保留状态首行，不能让尾部截断掩盖结果不完整。`read` 返回 continuation 行号；`find.truncated_by` 区分 `depth_limit`、`result_limit` 和 `output_limit`；`grep.truncated_by` 区分 `traversal_limit` 和 `result_limit`，不应用输出 token budget。正文 hit、related anchor、related 静默限额和 AST 增强的内部容量仅进入准确命名的 stats/telemetry 计数。

候选使用各工具定义的固定表示，预算只决定保留哪些完整候选，不随机截断或扩展同一候选。filesystem 文本 API 统一使用剥离 UTF-8 BOM 后正文的 UTF-8 byte 坐标；logical line、AST 和 position-hint range 不使用原始文件 BOM offset。详细 token 估算见 [Token Counter](../token-counter.md)。

## 统一错误

错误使用紧凑 `<error>` 标签，完整结构（包括 `code`、`path` 和 `details`）保留在工具结果中；模型正文不重复工具名和错误码：

```xml
<error>
File does not exist.
</error>
```

错误不会伪装成成功的零结果。无效正则仅在 exact literal 有直接命中时返回带警告的成功结果；没有 literal 证据时与路径错误、权限错误、取消和索引基础设施错误一样返回相应结构化错误。只有合法搜索但没有命中时才返回 success/none。

带有恢复方式的错误会增加 `next:` 提示。`READ_REQUIRED` 和 `STALE_READ` 要求重新读取文件；`OLD_TEXT_NOT_UNIQUE` 提供有限数量的可直接使用的唯一 `old/new` hints；`OLD_TEXT_NOT_FOUND` 优先说明前序 replacement 依赖或提供格式等价、稳定 anchor 候选，没有可靠候选时才要求重新读取。诊断不会放宽 edit 的严格匹配语义。

## 版本、取消与 mutation

`read` 可以在当前 session 记录原始字节版本。成功的 `write` 和 `edit` 由 filesystem commit callback 记录写入后的版本，因此 `write → edit` 可以直接执行；observation 以 canonical filesystem identity 为 key，明确 symlink 与目标共享版本身份。`edit` 在 per-target queue 内读取当前 snapshot 后校验 observation，避免覆盖排队期间或外部发生的修改。

`AbortSignal` 贯穿 host、filesystem operation、遍历/stream、worker 和 mutation queue。提交前取消不得写盘；mutation 一旦提交，后置 LSP 失败或取消只会安全降级，不能把已提交结果改成失败。系统只承诺同进程 canonical target 串行与 content-hash 乐观校验，不承诺跨进程锁、事务、回滚或自动 merge。

TUI 可以在展开态展示 `write` 或 `edit` 的精简 diff，但模型可见成功正文只确认写入事实，不包含完整 diff、版本字段或内部 fingerprint。

## Prompt 设计

工具 schema 字段描述承载参数约束和低频协议；系统提示词只保留高频决策规则：

- 知道目录时用 `ls`；
- 知道路径模式时用 `find`；
- 搜索正文或 symbol 时用 `grep`；
- 读取明确文件用 `read`；
- 新建或完整覆盖用 `write`；
- 局部修改遵循 `read → edit`。

重复的实现细节不进入长期 prompt。提示词字段的 Pi 适配见 [Pi 工具提示词字段](../tool-prompt-fields.md)。

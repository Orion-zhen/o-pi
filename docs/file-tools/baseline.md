# 阶段 1 行为基线

本文固化 Kernel 重构前六个模型可见文件工具的 public contract。结构化字段以各工具的 `types.ts` 和 schema 为准；下表记录迁移时最容易发生漂移的边界。

## 共享契约

- 相对路径按每次 Pi invocation 的 `ctx.cwd` 解析，项目配置也从该 cwd 查找；配置错误在 workspace I/O 前返回 `CONFIG_ERROR`。
- workspace 内绝对输入显示为 workspace-relative path；workspace 外绝对输入保持规范化绝对路径；`..` 相对输入保持规范化相对显示。
- blocked path 是访问控制：同时检查 lexical identity 和已存在目标 realpath；mutation 还检查最近存在父目录，并在队列内提交前重检。blocked entry 不可被 ignore 或增强 fail-open。
- `.piignore`、`.gitignore` 和 `ignored_path` 是 soft visibility。明确 `read`、`write`、`edit` 仍可访问；自动发现默认跳过。
- 明确输入 symlink 可以跟随到 workspace 内外；目录枚举仍把 child symlink 显示为 symlink，递归发现不跟随 child symlink。
- 失败统一为 `{ status: "failed", error: { code, message, path?, next?, edit_index?, expected?, actual?, details? } }`。合法零结果保持成功，不能伪装成错误。
- LSP、Repo Map、图片处理和结构上下文是 best-effort 增强。增强失败不改变基础操作；mutation 一旦写盘成功，后置增强失败或取消也不能改成失败。

## 六工具矩阵

| 工具 | 输入 | 成功 details 主形状 | symlink / soft-ignore / blocked | scope、排序与预算 | 取消、懒加载与增强 |
| --- | --- | --- | --- | --- | --- |
| `ls` | `{ path?: string }`，默认 `.`，单目录 | `{ path, entries[], truncated, returned_entries?, total_entries?, continuation_hint? }`；entry 含 `name/path/type/link_target?/ignored?/ignore_source?` | 明确目录 symlink 可跟随；child symlink 不跟随；ignored entry 返回 annotation；blocked root 失败、blocked child 隐藏 | 仅直属成员；directory/file/symlink/other 后按名称稳定排序；`ls_entries` 截断 | adapter 当前不承诺中途取消；只加载 `ls` module，无 LSP/Repo Map |
| `read` | `{ path, start_line?, end_line? }`，行号 1-based inclusive | 文本 `{ path, content, start_line, end_line, total_lines, size_bytes, version, encoding, newline, truncated, continuation?, bom, ignored? }`；图片另含 `media_type/mime_type/image` | 明确文件 symlink 可跟随；ignored 文件可读并 annotation；blocked 失败 | 单文件；`read_lines`、`read_bytes` 截断并返回 continuation；缺失路径建议受 `read_suggestion_limit` 限制 | adapter 当前不承诺中途取消；完整 read 不加载 LSP，partial/truncated 才请求结构增强；Repo Map/skill/image 按路径懒加载并可降级 |
| `write` | `{ path, content }`，完整覆盖，可创建父目录 | `{ status: "written", path, bytes, action, before_version?, after_version, before_size_bytes?, after_size_bytes, diff, firstChangedLine?, lsp?, repo_map? }` | 可覆盖明确 symlink target；soft-ignore 不阻止；blocked target/parent 失败，并在 mutation queue 内重检 | 单文件，无输出正文预算；diff 仅在 details/TUI | `AbortSignal` 在排队和提交前边界生效；成功后记录 session observation，因此可直接 `edit`；LSP/Repo Map 后置失败或取消仍成功 |
| `edit` | `{ path, edits: [{ old, new }, ...] }`；`old` 非空、唯一，replacement 不重叠 | `{ status: "applied", path, replacements, old_version, new_version, old_size_bytes, new_size_bytes, diff, firstChangedLine?, lsp?, repo_map? }` | 明确文件 symlink 解析后编辑目标；soft-ignore 不阻止；blocked 失败并在 queue 内重检 | 单文件；全部 replacement 针对调用开始时原文；hint 数受 `edit_match_hint_limit` 限制 | 必须有当前 session observation；`read` 或成功 `write/edit` 均可建立 observation；`AbortSignal` 提交前生效；提交后增强安全降级 |
| `find` | `{ query, path?: string[] }`；query 为名称、路径片段、概念或 glob | `{ content, details: { query, path, paths, scope_errors?, strategy, totalMatches, returnedMatches, scannedEntries, matches, collapsedGroups, ignoredCount, skippedCount, scanTruncated, resultLimited, outputTruncated, nearby?, related? } }` | 明确 root symlink 可跟随；递归 child symlink 不跟随；明确 ignored root 可穿过，自动候选跳过；blocked scope 失败/partial error | 多 scope OR/union，规范化、嵌套去重、全局去重和稳定排序；scan/result/token 三类预算分别可见 | 遍历/worker 响应取消；首次只加载 find，Repo Map 激活且需要语义候选时加载；外部候选实时复核，失败降级 |
| `grep` | `{ query, path?: string[], match?: "auto"|"literal"|"regex", glob? }` | `{ status: "success", query, path, paths?, scope_errors?, match, strategy, total_candidates, returned_regions, returned_files, approx_tokens, scanned_files, truncated, regions, skipped_files?, nearby?, related? }` | 明确 file/dir symlink root 可跟随；递归 child symlink 不跟随；明确 ignored scope 可穿过，自动扫描跳过；blocked scope 失败/partial error | 多 scope OR/union、全局去重和稳定 ranking；文件数、文件大小、semantic 数、结果数和 token budget 独立生效 | 流扫描、index、parser/worker 响应取消；Tree-sitter/LSP/Repo Map 按实际策略懒加载并降级；external candidate 必须通过 scope/glob/live content/hash gate |

## Lazy load 与生命周期基线

- 注册阶段只注册 schema 和轻量 adapter loader，不导入六工具实现、LSP、Repo Map、Tree-sitter 或 native renderer。
- 同一工具并发 import 共享 retryable Promise；失败后下次可重试。
- TUI `session_start` 才加载 renderer；RPC 不加载。
- shutdown 只清理已加载模块、session cache、已激活 Repo Map 和已加载 LSP；不能为清理而加载未使用模块。

## 可执行证据

| 风险 | 主要测试 |
| --- | --- |
| schema、success/failure shape、path display、symlink、ignore、blocked、CRUD、`write -> edit` | `tests/file-tools/schema.test.ts`、`crud.test.ts`、`ignore-engine.test.ts` |
| invocation cwd 项目配置及 `CONFIG_ERROR` 顺序 | `tests/file-tools/config-invocation.test.ts`、`config.test.ts` |
| mutation queue 重检、edit 取消、observation 与并发 edit | `tests/file-tools/crud.test.ts` |
| multi-scope、排序、预算、nearby/related、外部候选复核与取消 | `tests/file-tools/find.test.ts`、`grep.test.ts`、`lsp-hooks.test.ts`、`tests/repo-map/file-tools.test.ts` |
| post-mutation 增强降级、lazy import、RPC/TUI renderer、shutdown | `tests/file-tools/extension.test.ts`、`lsp-hooks.test.ts` |
| 最终 import 方向且无 legacy 例外 | `tests/file-tools/architecture.test.ts` |

阶段 1 的完整测试、typecheck 和 coverage 结果记录在 `TASK.md`；后续阶段必须以本页和上述测试判断行为回归。

# `grep`

`grep` 按内容、symbol、正则或代码意图检索代码，不查找路径、不修改文件。执行链固定为 `QueryPlan -> ScopeInventory -> text candidates -> AST regionization -> local ranking -> optional position hints -> explicit relation fallback -> packing`。普通查询的候选只来自当前正文；Tree-sitter 把已有文本候选折叠到最小代码单元、补充最少结构字段并合并同一区域，不独立召回 symbol、完整 code unit 或相似候选。结果按函数、方法、类、声明聚合；没有语法归属的正文候选保持为独立文本行。

## 参数

```json
{
  "query": "AuthService.login",
  "path": ["src", "tests"],
  "match": "auto",
  "glob": "**/*.{ts,tsx}"
}
```

- `query`：文本、symbol、qualified symbol、显式正则或自然语言代码意图。
- `path`：非空目录或普通文件 scope 数组，默认 `["."]`。多个 scope 是 OR/union。
- `match`：`auto`、`literal` 或 `regex`，默认 `auto`。
- `glob`：相对每个 path 的候选文件 glob，只进一步缩小范围；不含 `/` 时递归匹配 basename，含 `/` 时匹配 scope-relative path。
- 相对路径按 `cwd` 解析；目录递归检索，文件只检索该文件。
- `path: []` 和空元素非法。

旧的单路径或分隔字符串由 `tool-repair` 迁移；无法可靠解析时交给 schema 校验失败，不猜测路径。

## Match 模式

### `auto`

正文扫描同时产生精确 hit 和有界 lexical line anchor。Tree-sitter 只处理包含这些文本候选的文件，并将候选映射到最小 live AST unit；qualified symbol 由文本 anchor 与该 unit 的 qualified name 共同确认。精确符号存在歧义时请求 LSP 位置提示，提示只能与本次 live unit 合并。显式 caller/callee/reference/test/import/registration/entrypoint 查询先请求 LSP；没有有效关系结果时，才允许 Tree-sitter 在 scope 内生成关系回退。

`auto` 不会猜测正则。

### `literal`

对每个 logical line 执行区分大小写的精确字符串搜索。受支持代码中的命中随后按最小 enclosing code unit 聚合；AST 外命中保持逐行事实。

### `regex`

对每个 logical line 独立执行显式正则搜索，不支持跨行。无效正则返回 `INVALID_REGEX`，不会伪装成零结果。

## 成功输出

成功结果是紧凑文本，不是冗长 JSON：

```text
<grep>
src/auth/service.ts:41-88 [kind=method; symbol=AuthService.login; roles=definition,public-api; matched-by=exact-symbol]
  declaration: async login(credentials: Credentials): Promise<Session>

src/auth/handler.ts:20-64 [kind=function; symbol=handleLogin; roles=occurrence; matched-by=literal]
  declaration: export async function handleLogin(req: Request)
  matching lines (2 of 5 shown):
    37: const session = await auth.login(credentials);
    59: return session;

src/session/cache.ts:12-46 [kind=method; symbol=SessionCache.restore; roles=definition; matched-by=lexical]
  declaration: restore(key: SessionKey): Promise<Session | undefined>
  evidence line 29: const cachedSession = await this.storage.load(key);

notes.conf:14: fatal authentication error
notes.conf:27 [evidence=lexical]: authentication request rejected
</grep>
```

代码结果始终保留完整最小语法区域范围，并只携带 body-free declaration 与有界 matching/evidence 行。1 个 verified 展示行使用 `matching line N:`；多个命中或展示受限时使用 `matching lines (K of N shown):`。semantic 证据使用 `evidence line N:`，不与 verified 命中混写。declaration 和证据行各自最多 240 个 Unicode code point；超长行围绕相关位置使用 ASCII `...` 截取。完整源码由 `read(path,start_line,end_line)` 返回。

`details.regions` 保留相同的 range、kind、symbol、roles、matched_by，以及完整 `match_lines` 和有界 `display_lines`；`sources` 记录正文候选来源，显式关系回退另记 `ast-relation`。结构折叠本身不是候选证据。LSP hint 的 origin、confidence 和 reason 不进入模型正文、details、TUI 或 grep telemetry candidate projection。TUI 展开视图只显示区域元数据和匹配总数，不显示 declaration 或 evidence 源码。

每个候选只有一个固定表示。`grep_regional_display_limit` 控制每个语法区域展示的源码行数，但不裁剪 `details.match_lines`；`grep_output_token_budget` 只决定保留哪些候选，不升级 body、上下文或更多行。`grep_result_limit` 限制 regions；`grep_relation_action_limit` 另外限制整次调用中的显式关系结果数，默认 2。输出状态和公共协议见 [工具契约](contracts.md)。

## 语言与解析

C/C++、TypeScript、TSX、JavaScript、JSX、Python、Go、Rust 使用 Tree-sitter grammar 提取最小代码单元、declaration 和显式关系回退需要的局部事实：

- 函数、方法、类；
- 接口、trait、类型和枚举；
- 模块和顶层声明；
- C/C++ 的受限 `#include` 文件关系。

不支持或解析失败的语言退化为逐行文本搜索。verified 文本使用 `path:line: content`，semantic 文本使用 `path:line [evidence=lexical]: content`；无 Tree-sitter grammar 的文件不启动语法解析。

## 搜索流程

每次 invocation 使用 host 已绑定的不可变 visibility snapshot。默认目录遍历使用 `search` intent；显式 path 指向 soft ignored 文件或目录时，允许在该路径内检索。普通 dotfile 可检索，blocked path 不可检索；递归不跟随 child symlink，明确 file/dir symlink root 可以解析后检索。

检索先建立 `ScopeInventory`：按输入顺序逐 scope 消费 filesystem discovery，应用 visibility 与 scope-relative glob，再按 snapshot 中的 canonical object identity 去重。glob 拒绝 absolute、NUL 和 `..` segment；不含 `/` 时递归匹配 basename，含 `/` 时匹配相对原始 scope 的 `/` 规范化路径。filesystem 使用静态目录前缀剪枝 traversal；前缀不存在表示该 scope 零匹配，不误报 scope 不存在，也不重置原始深度。父 scope 不删除显式子 scope，因此 soft ignored 子目录仍可由显式 scope 补回。

inventory entry 携带 filesystem 捕获的 object identity、version 和 size snapshot。所有模式都通过 `scanLines` 要求打开的文件仍等于该 snapshot，并在扫描结束再次验证稳定性。`literal` 和 `regex` 到此只继续本地 regionization、ranking 和 packing，绝不调用 LSP。文件在 inventory 后或读取期间变化时不会保留部分命中：递归 scope 计入 `skipped_files.changed`，显式文件 scope 返回对应错误。

LF、CRLF、CR 和 UTF-8 BOM 由 filesystem logical line 语义统一处理。`ScannedLine`、`TextContent.text`、AST 和 position-hint range 均使用剥离 BOM 后正文的 UTF-8 byte 坐标；行扫描的 byte 范围不包含行终止符。grep 不修正 BOM offset，也不把原始文件 byte 坐标与正文坐标混用。

每个 scope 独立应用 `grep_max_depth`：scope 根为 0，直属子项为 1；glob 静态前缀剪枝不会重置深度。正文事实扫描不按文件数量、累计字节或单文件字节提前停止。语法增强只受 `grep_ast_max_file_bytes` 约束，超限文件仍保留已验证文本命中。

本地排序完成后才计算 hint demand：

- identifier/qualified symbol 出现多个本地精确定义时，请求 LSP 消歧。
- 显式关系查询总是先请求可选 LSP。
- 其他情况不启动 hint source。

hint port 只返回 grep-owned path/range DTO 和最小 freshness/关系/排序信息。path 必须属于本次 inventory，range 必须落入本次已经读取和解析的 live AST unit；range 无效、LSP 指向的 unit 不精确匹配查询，或关系角色不是用户请求的角色时直接丢弃。公开 path、range、kind、symbol 和 declaration 全部重新取自该 AST unit。显式关系没有有效 LSP 结果时才执行本地 AST relation fallback。Tree-sitter/text 与 LSP 的职责和融合规则见 [排序证据](ranking-evidence.md)。

## Scope、跳过和截断

多个 scope 合并为一个全局结果，先按文件 canonical identity、再按稳定 region key 去重。每个 scope 分别应用深度边界；regions 共享结果数量与模型 token 预算。

至少一个 scope 成功时保留有效区域，并在 `details.scope_errors` 及模型输出中标注失败 scope；所有 scope 失败时返回结构化错误。

二进制、非法 UTF-8、读取期间变化和局部权限失败在递归检索中计入 `skipped_files`；显式检索单个文件时返回对应错误。正文使用流式扫描，因此不因文件大小跳过。

输出限制通过 `truncated_by` 分别标记：

- `traversal_limit`；
- `text_byte_limit`；
- `semantic_candidate_limit`；
- `result_limit`；
- `token_budget`。

打包器为每个候选建立唯一固定胶囊，在预算内优先保留最高价值候选，再尽量增加独立区域数。token 预算不会改变区域锚点、declaration 或代表行；只有整个候选未返回时才标记 `token_budget`。限制由 [配置](configuration.md) 控制，不作为工具参数暴露。line stream、traversal、parser 和 worker 都响应取消并释放 handle。

## 零结果

合法搜索但没有合格文本候选或显式关系结果时，`regions` 保持为空。grep 不生成 AST nearby、fuzzy 或 `related` 候选；输出 `searched=<searched_files>; skipped=<count>` 和下一步建议。

显式关系查询的有效 LSP 或 AST fallback region 进入主结果，并受 `grep_relation_action_limit` 限制。结果选择边界见 [排序选择](ranking-selection.md)。

## 失败结果与模型输出

参数、正则或所有 scope 失败时返回紧凑 XML；路径、scope 子错误和解析详情保留在 `details`：

```xml
<error>
query is not a valid regular expression.
</error>
```

常见失败及正文：

| code | 模型正文 |
| --- | --- |
| `INVALID_OPERATION` | `query must not be empty.`、`query must not contain NUL bytes.` 或 `match must be auto, literal, or regex.` |
| `INVALID_PATH` | `path must contain at least one scope.`、`path entries must be non-empty strings.` 或 `glob must not be empty.` |
| `INVALID_REGEX` | `query is not a valid regular expression.` |
| `PATH_NOT_FOUND` | `Path does not exist.` 或 `No searchable scope was provided.` |
| `PROTECTED_PATH` | `Path is blocked by file-tools config.` |
| `ACCESS_DENIED` | `Path cannot be accessed.` 或 `Path cannot be searched.` |
| `FILE_NOT_FOUND` | `File cannot be read.` |
| `BINARY_FILE_UNSUPPORTED` | `Binary files are not supported.` |
| `ENCODING_UNSUPPORTED` | `Only valid UTF-8 text is supported.` |
| `OUTPUT_LIMIT_EXCEEDED` | `File is too large to search.` |
| `OPERATION_ABORTED` | `grep was aborted.` |
| `CONFIG_ERROR` | 配置错误消息 |

只有部分 scope 失败时不是 error，而是成功正文中的警告：

```text
<grep>
partial; scope_errors=missing:PATH_NOT_FOUND
none
...
</grep>
```

`next:` 只有错误提供恢复建议时才出现。

## Cache 与生命周期

`GrepTool` 按 canonical workspace identity、visibility fingerprint 和文件 snapshot/hash 管理派生 AST cache；cache 只保存 parsed units，不取代当前 inventory 与正文事实扫描。packer 不持有完整源码；使用索引前仍进行当前 visibility 与 snapshot-bound 内容 gate。新增、修改、删除或 ignore fingerprint 变化会进入新 snapshot/cache key。

pending index build、parser pool 和 worker 由该 `GrepTool` instance 持有。`dispose()` abort pending consumers、释放 parser/worker 并清理 derived cache，不要求 Pi adapter知道内部 cache 名称，也不影响 find 或 filesystem factual cache。

# `grep`

`grep` 按内容、symbol、正则或代码意图检索代码，不查找路径、不修改文件。执行链固定为 `QueryPlan -> ScopeInventory -> text/local channels -> live validation -> regionization -> ranking -> packing`；command 通过 filesystem discovery 建立 inventory，并只以 snapshot-bound content/line scan 读取正文，LSP 与 Repo Map 通过独立 port 接入。结果按函数、方法、类、声明聚合；没有语法归属的结果保持为独立文本行。

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

组合使用本地正文、AST、LSP 与 Repo Map 排序信号。只有 exact qualified symbol、exact symbol，以及用户明确请求的 caller/reference/test/registration/entrypoint 等关系候选可以脱离正文命中独立进入主结果。symbol prefix、short symbol、alias、package、component 和普通 export 只参与内部排序。

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

`details.regions` 保留相同的 range、kind、symbol、roles、matched_by，以及完整 `match_lines` 和有界 `display_lines`；内部 `sources` 只留在 details/telemetry。TUI 展开视图只显示这些区域元数据和匹配总数，不显示 declaration 或 evidence 源码。

每个候选只有一个固定表示。`grep_regional_display_limit` 控制每个语法区域展示的源码行数，但不裁剪 `details.match_lines`；`grep_output_token_budget` 只决定保留哪些候选，不升级 body、上下文或更多行。`grep_result_limit` 是 main、nearby 与 related 的全局条数上限；`grep_relation_action_limit` 另外限制整次调用中的关系行动总数，默认 2，不随 main 数量增长。输出状态和公共协议见 [工具契约](contracts.md)。

## 语言与解析

C/C++、TypeScript、TSX、JavaScript、JSX、Python、Go、Rust 使用 Tree-sitter 官方 grammar 提取：

- 函数、方法、类；
- 接口、trait、类型和枚举；
- 模块和顶层声明；
- C/C++ 的受限 `#include` 文件关系。

不支持或解析失败的语言退化为逐行文本搜索。verified 文本使用 `path:line: content`，semantic 文本使用 `path:line [evidence=lexical]: content`；无 Tree-sitter grammar 的文件不启动语法解析。

## 搜索流程

每次 invocation 使用 host 已绑定的不可变 visibility snapshot。默认目录遍历使用 `search` intent；显式 path 指向 soft ignored 文件或目录时，允许在该路径内检索。普通 dotfile 可检索，blocked path 不可检索；递归不跟随 child symlink，明确 file/dir symlink root 可以解析后检索。

检索先建立 `ScopeInventory`：按输入顺序逐 scope 消费 filesystem discovery，应用 visibility 与 scope-relative glob，再按 snapshot 中的 canonical object identity 去重。glob 拒绝 absolute、NUL 和 `..` segment；不含 `/` 时递归匹配 basename，含 `/` 时匹配相对原始 scope 的 `/` 规范化路径。filesystem 使用静态目录前缀剪枝 traversal；前缀不存在表示该 scope 零匹配，不误报 scope 不存在，也不重置原始深度。父 scope 不删除显式子 scope，因此 soft ignored 子目录仍可由显式 scope 补回。

inventory entry 携带 filesystem 捕获的 object identity、version 和 size snapshot。`literal` 和 `regex` 随后通过 `scanLines` 要求打开的文件仍等于该 snapshot，并在扫描结束再次验证稳定性；Repo Map/LSP 只能给这些事实区域补充排序证据，不能创建 main 或 related。文件在 inventory 后或读取期间变化时不会保留部分命中：递归 scope 计入 `skipped_files.changed`，显式文件 scope 返回对应错误。

LF、CRLF、CR 和 UTF-8 BOM 由 filesystem logical line 语义统一处理。`ScannedLine`、`TextContent.text`、AST 和 external range 均使用剥离 BOM 后正文的 UTF-8 byte 坐标；行扫描的 byte 范围不包含行终止符。grep 不修正 BOM offset，也不把原始文件 byte 坐标与正文坐标混用。

每个 scope 独立应用 `grep_max_depth`：scope 根为 0，直属子项为 1；glob 静态前缀剪枝不会重置深度。正文事实扫描不按文件数量、累计字节或单文件字节提前停止。语法增强只受 `grep_ast_max_file_bytes` 约束，超限文件仍保留已验证文本命中。

增强阶段可并行执行 LSP symbol 与 Repo Map graph ports；它们只返回 grep-owned DTO。每个 external candidate 都必须命中 filesystem allowed ref，并以 inventory snapshot 读取同一版正文，再通过 scope、visibility、glob、正文 range、可选 content version/hash 和预算 gate；即使候选没有 hash/version，也不能应用到 inventory 后变化的正文。Repo Map hop-2 在 adapter 边界丢弃，hop-1 仅在显式关系查询或主结果为空时可见。Tree-sitter/text、LSP 和 Repo Map 的职责与融合规则见 [排序证据](ranking-evidence.md)。

## Scope、跳过和截断

多个 scope 合并为一个全局结果，先按文件 canonical identity、再按稳定 region key 去重。每个 scope 分别应用深度边界；main、nearby 和 related 共享条目数量与模型 token 预算。

至少一个 scope 成功时保留有效区域，并在 `details.scope_errors` 及模型输出中标注失败 scope；所有 scope 失败时返回结构化错误。

二进制、非法 UTF-8、读取期间变化和局部权限失败在递归检索中计入 `skipped_files`；显式检索单个文件时返回对应错误。正文使用流式扫描，因此不因文件大小跳过。

输出限制通过 `truncated_by` 分别标记：

- `traversal_limit`；
- `text_byte_limit`；
- `semantic_candidate_limit`；
- `result_limit`；
- `token_budget`。

打包器为每个候选建立唯一固定胶囊，在预算内优先保留最高价值候选，再尽量增加独立区域数。token 预算不会改变区域锚点、declaration 或代表行；只有整个候选未返回时才标记 `token_budget`。限制由 [配置](configuration.md) 控制，不作为工具参数暴露。line stream、traversal、parser 和 worker 都响应取消并释放 handle。

## 零结果、nearby 与 related

合法搜索但没有主命中时，`regions` 保持为空，仍可能返回最多 3 个本地 `nearby`：

- `symbol similarity`：symbol typo；
- `partial terms`：只有部分 query terms 重合；
- `path similarity`：只有路径相关。

`nearby` 只在最终主结果为空时出现，不参与主候选排序或 `returned_regions`，模型文本使用 `<nearby query-match="not-guaranteed">` 明示非命中；它与其他通道共享全局 `grep_result_limit`。

显式关系查询把 direct/hop-1 关系作为 main 行动；没有主结果时，可信 Repo Map hop-1 可使用 `<related query-match="not-guaranteed">` 提供回退导航。两者共用 `grep_relation_action_limit`。literal/regex、普通 direct、hop-2、package/component/alias/same-component 不生成 related。没有可信 nearby 或 related 时，输出 `searched=<searched_files>; skipped=<count>` 和下一步建议。

main、nearby、related 的完整边界见 [排序选择](ranking-selection.md)。

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

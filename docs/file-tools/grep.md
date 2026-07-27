# `grep`

`grep` 按内容、symbol、正则或代码意图检索代码，不查找路径、不修改文件。command 只通过 filesystem traversal/content/line scan/hash 访问文件，并组合 grep-local index/ranking/packing 与可选 symbol/graph ports。结果按函数、方法、类、声明或紧凑文本片段聚合。

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

组合使用：

- exact qualified symbol；
- exact symbol；
- symbol prefix；
- literal occurrence；
- 词法相关性；
- 一跳 caller/callee/import 关系。

`auto` 不会猜测正则。

### `literal`

对每个 logical line 执行区分大小写的精确字符串搜索。阶段化区域解析前，每个命中行先形成带有限前后文的 verified 文本窗口；后续区域化再按 code unit 聚合。

### `regex`

对每个 logical line 独立执行显式正则搜索，不支持跨行。无效正则返回 `INVALID_REGEX`，不会伪装成零结果。

## 成功输出

成功结果是紧凑文本，不是冗长 JSON：

```text
<grep>
in src/auth/
service.ts:41-88 AuthService.login [definition,exact symbol]
async login(credentials: Credentials) {
	...
}
token.ts:14 issueToken [callee]
</grep>
```

输出按 `grep_output_token_budget` 选择正文、片段和 signature：默认最多两个完整 body；其余候选优先输出路径、范围和完整 signature。同目录区域共享 `in path/` 前缀。超大函数保留 signature、命中附近片段和省略标记，不吞掉全部预算。

只有关系促成命中且正文已降级为 signature 时，才补充 calls/imports，避免重复正文。输出状态和公共协议见 [工具契约](contracts.md)。

## 语言与解析

C/C++、TypeScript、TSX、JavaScript、JSX、Python、Go、Rust 使用 Tree-sitter 官方 grammar 提取：

- 函数、方法、类；
- 接口、trait、类型和枚举；
- 模块和顶层声明；
- C/C++ 的受限 `#include` 文件关系。

不支持或解析失败的语言退化为文本搜索和紧凑行窗口。无 Tree-sitter grammar 的文件直接建立等价文本索引，不启动语法解析。

## 搜索流程

每次 invocation 使用 host 已绑定的不可变 visibility snapshot。默认目录遍历使用 `index` intent；显式 path 指向 soft ignored 文件或目录时，允许在该路径内检索。普通 dotfile 可检索，blocked path 不可检索；递归不跟随 child symlink，明确 file/dir symlink root 可以解析后检索。

检索先建立 `ScopeInventory`：按输入顺序逐 scope 发现文件，应用 visibility 与 glob，再按 filesystem canonical identity 去重。glob 的静态目录前缀用于剪枝 traversal；前缀不存在表示该 scope 零匹配，不误报 scope 不存在。父 scope 不删除显式子 scope，因此 soft ignored 子目录仍可由显式 scope 补回。

`literal` 和 `regex` 随后只通过 filesystem `scanLines` 执行稳定流式扫描，不完整读取正文、不解析 AST，也不调用 LSP 或 Repo Map。LF、CRLF、CR 和 BOM 由 filesystem logical line 语义统一处理；扫描失败的文件不会保留读取到一半的命中。

所有 scope 共享 `grep_max_entries_traversed`。正文事实扫描使用独立的 `grep_max_text_bytes_scanned` 和 `grep_max_text_file_bytes`；语法增强只受 `grep_max_files_parsed` 与 `grep_max_parse_file_bytes` 约束，不能删除已验证文本命中。

`auto` 的增强阶段可并行执行 LSP symbol 与 Repo Map graph ports；它们只返回 grep-owned DTO。每个 external candidate 都必须命中 filesystem allowed ref，并通过 scope、visibility、glob、live text/range/hash 和预算 gate；related edge 的文件 hash 也在当前调用复核。Tree-sitter/text、LSP 和 Repo Map 的职责与融合规则见 [排序证据](ranking-evidence.md)。

## Scope、跳过和截断

多个 scope 合并为一个全局结果，先按文件 canonical identity、再按稳定 region key 去重。所有 scope 共享 traversal、文本字节、区域数量和模型 token 预算。

至少一个 scope 成功时保留有效区域，并在 `details.scope_errors` 及模型输出中标注失败 scope；所有 scope 失败时返回结构化错误。

二进制、非法 UTF-8、超大文件、读取期间变化和局部权限失败在递归检索中计入 `skipped_files`；显式检索单个文件时返回对应错误。

输出限制通过 `truncated_by` 分别标记：

- `traversal_limit`；
- `text_byte_limit`；
- `semantic_candidate_limit`；
- `result_limit`；
- `token_budget`。

限制由 [配置](configuration.md) 控制，不作为工具参数暴露。line stream、traversal、index build、parser 和 worker 都响应取消并释放 handle；共享 build 以 consumer 计数管理，只有最后消费者退出才取消底层构建。

## 零结果、nearby 与 related

合法搜索但没有主命中时，`regions` 保持为空，仍可能返回最多 3 个本地 `nearby`：

- `symbol similarity`：symbol typo；
- `partial terms`：只有部分 query terms 重合；
- `path similarity`：只有路径相关。

`nearby` 只在最终主结果为空时出现，不参与主候选排序、result limit 或 `returned_regions`，模型文本使用 `<nearby nonmatch>` 明示非命中。

Repo Map 关系使用独立的 `<related repo-map nonmatch>` 通道，明示 `query_match: not_guaranteed`，不能伪装成 literal/regex 命中。没有可信 nearby 或 related 时，输出 `searched=<scanned_files>; skipped=<count>` 和下一步建议。

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

`GrepTool` 按 canonical workspace identity、visibility fingerprint、scope、query filter 和 limits 管理 derived cache。单文件 entry 只保存 metadata/hash/index，不永久保存完整源码；使用前仍进行当前 visibility 与内容 gate。新增、修改、删除或 ignore fingerprint 变化会进入新 snapshot/cache key。

pending index build、parser pool 和 worker 由该 `GrepTool` instance 持有。`dispose()` abort pending consumers、释放 parser/worker 并清理 derived cache，不要求 Pi adapter知道内部 cache 名称，也不影响 find 或 filesystem factual cache。

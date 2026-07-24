# `grep`

`grep` 按内容、symbol、正则或代码意图检索代码，不查找路径、不修改文件。结果按函数、方法、类、声明或紧凑文本片段聚合。

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
- `glob`：相对每个 path 的候选文件 glob，只进一步缩小范围。
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

执行区分大小写的精确字符串搜索，同一 code unit 内多次命中合并为一个 region。主候选必须在当前正文中重新命中。

### `regex`

执行显式正则搜索。无效正则返回 `INVALID_REGEX`，不会伪装成零结果。

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

每次调用创建 ignore snapshot。默认目录遍历使用 ignore 的 `index` intent；显式 path 指向 soft ignored 文件或目录时，允许在该路径内检索。普通 dotfile 可检索，blocked path 不可检索；递归不跟随文件或目录 symlink。

`literal` / `regex` 先逐行预筛全部合规候选，只对真实命中文件运行 Tree-sitter，不受语义候选上限影响。

候选文件数不超过 `grep_max_semantic_files` 时，`auto` 构建完整语义索引。超过时启用语义预筛，根据 exact phrase、查询词覆盖、路径覆盖和 declaration 优先级选择高相关文件，并显式标记 `truncated`。大于 `grep_max_semantic_parse_bytes` 的候选保留文本召回，但不进入可能耗时过长的语法解析。

文本 fallback 只统计 query 所需 token，并在首次真实命中时构建 UTF-8 行索引。缓存 AST 仍须经过当前 query 的预筛和统一 Top-K，不能绕过语义候选上限。

LSP 与 Repo Map 查询可以并行执行；候选源码和 related-file hash 会在当前调用内复核。Tree-sitter/text、LSP 和 Repo Map 的职责与融合规则见 [排序证据](ranking-evidence.md)。

## Scope、跳过和截断

多个 scope 合并为一个全局结果，按稳定 region key 去重。所有 scope 共享区域数量、扫描文件数和模型 token 预算。

至少一个 scope 成功时保留有效区域，并在 `details.scope_errors` 及模型输出中标注失败 scope；所有 scope 失败时返回结构化错误。

二进制、非法 UTF-8、超大文件和局部权限失败在递归检索中计入 `skipped_files`；显式检索单个文件时返回对应错误。

输出限制可能同时包含：

- 扫描文件被限制；
- 语义候选被限制；
- 返回 region 被限制；
- 模型文本被 token budget 降级。

限制由 [配置](configuration.md) 控制，不作为工具参数暴露。

## 零结果、nearby 与 related

合法搜索但没有主命中时，`regions` 保持为空，仍可能返回最多 3 个本地 `nearby`：

- `symbol similarity`：symbol typo；
- `partial terms`：只有部分 query terms 重合；
- `path similarity`：只有路径相关。

`nearby` 只在最终主结果为空时出现，不参与主候选排序、result limit 或 `returned_regions`，模型文本使用 `<nearby nonmatch>` 明示非命中。

Repo Map 关系使用独立的 `<related repo-map nonmatch>` 通道，明示 `query_match: not_guaranteed`，不能伪装成 literal/regex 命中。没有可信 nearby 或 related 时，输出 `searched=<scanned_files>; skipped=<count>` 和下一步建议。

main、nearby、related 的完整边界见 [排序选择](ranking-selection.md)。

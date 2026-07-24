# Repo Map 集成边界

Repo Map 是 File Tools 的内部增强，不增加模型可见的独立工具。

## `find`

`find` 可以把 Repo Map 用作路径、architecture 和 semantic candidate 来源。基础路径匹配仍然可用；Repo Map 不可用时，`find` 退回 filesystem scan。

Repo Map 候选必须经过路径、ignore、新鲜度和结果去重处理，不能让 stale 图中的路径取代实时 scope 规则。

## `grep`

`grep(auto)` 可以使用 Repo Map 的 symbol、alias、relationship 和 architecture 候选，随后用当前文件内容验证主结果。

`literal` 和 `regex` 的主结果以实时正文匹配为准。Repo Map 只能补充结构上下文或 related/nearby 结果，不能把没有正文证据的候选标记为 literal 命中。

## `read`

`read` 可以请求 Repo Map context，例如 enclosing symbol、相关调用者或测试。文件正文仍由 `read` 自己读取，因此 Repo Map 过期不会使读取到旧内容。

## Mutation

`write` 和 `edit` 可以触发 diagnostics 或 mutation impact。修改后的 refresh 按 map ID 串行执行，防止并发 generation 提交乱序。

Repo Map 不提供写入权限，也不替代 edit 的 read-before-edit、版本检查或 path guard。

## LSP

LSP 是独立的可选增强：

- Repo Map 可以使用静态 parser、manifest、convention 或 LSP 来源建立关系。
- LSP 不可用时不应阻止 Repo Map 建图。
- LSP 的独立设计见 [lsp.md](../lsp.md)。

## 退化原则

任何增强失败都必须保留基础行为：

- Repo Map 失败不阻止 `ls`、`find`、`grep`、`read`、`write` 或 `edit`。
- 结构候选失败不应伪装成正文搜索失败。
- diagnostics、skipped files 和 freshness 必须可观察。

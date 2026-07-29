# Repo Map 集成边界

Repo Map 是 File Tools 的内部增强，不增加模型可见的独立工具。

## `find`

`find` 默认只用 Repo Map 调整已有路径结果的排序。package、component、alias、same-component 和普通关联候选不会独立进入结果；基础路径召回为空时，仅允许高置信 exact symbol、registration 或 entrypoint 文件按配置上限回退。`find` 不生成 Repo Map `related` 输出。

Repo Map 候选必须经过路径、ignore、新鲜度、实时 hash 和结果去重处理，不能让 stale 图中的路径取代实时 scope 规则。Repo Map 不可用时，`find` 保持 filesystem 路径扫描和排序。

## `grep`

`grep(auto)` 与 `literal`/`regex` 共享完整 `ScopeInventory`；Repo Map 通过独立 graph port 提供 symbol、alias、relationship 和 architecture 候选。候选不受本地 parse/semantic Top-K 门控，随后统一用当前文件内容验证 scope、glob、visibility、版本/hash 和 range。

`literal` 和 `regex` 的主结果以实时正文匹配为准。Repo Map 只能增强已验证 region，或补充 `related`；不能把没有正文证据的候选标记为 strict 命中。无显式关系意图的 caller/test/import 等结构候选保持在 `related`。

## `read`

`read` 可以请求 Repo Map context，例如 enclosing symbol、相关调用者或测试。文件正文仍由 `read` 自己读取，因此 Repo Map 过期不会使读取到旧内容。

## Mutation

`write` 和 `edit` 可以触发 diagnostics 或 mutation impact。只有已存在于 generation，或当前属于 Repo Map 扫描范围的文件才触发 refresh；blocked、`ignored_path`、`.gitignore` 和 `.piignore` 排除的新文件不会刷新索引。未被忽略的 untracked 新文件仍可进入 Repo Map。

文件成功提交后，工具同步等待按 map ID 串行的 refresh；不会在后台刷新，也不存在 debounce 或最终一致性窗口。mutation 链路把调用开始时已验证的 before generation 交给 service，service 在锁内确认 root、map ID、activation generation 和磁盘 `CURRENT` 后才复用；失配则回到正常 generation reader。原子 commit 成功后追加 activation，并直接使用 refresh 返回的内存 generation 分析 impact，不再重读 after generation。impact 最终候选仍以实时 content hash 过滤。

Repo Map 不提供写入权限，也不替代 edit 的 read-before-edit、版本检查或 path guard。Repo Map refresh、impact 索引或格式化失败都属于 best-effort enhancement 降级，不能回滚或伪装已成功的文件 mutation。

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

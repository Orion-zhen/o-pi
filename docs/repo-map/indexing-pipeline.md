# Repo Map 索引流水线

一次 Repo Map 初始化或 refresh 按以下顺序执行。

## 1. 检测仓库

从 `cwd` 检测 repository root、worktree root、Git common directory 和当前 HEAD revision。无法确定仓库身份时，初始化失败，不创建半成品 generation。

## 2. 加载配置和 ignore snapshot

服务同时加载 Repo Map 配置与 File Tools 配置，然后创建 immutable ignore snapshot。snapshot 的 fingerprint 会写入 generation metadata。

扫描上限取 Repo Map scan limits 与 File Tools grep limits 中更严格的一组。

## 3. 扫描文件

scanner 负责：

- 发现候选文件。
- 应用 ignore、路径和文件大小规则。
- 读取文件身份、size、mtime 和必要的 hash。
- 统计新增、改变、删除、过大、不可读和不稳定文件。
- 在达到文件数量或取消信号时停止。

已有 generation 可提供 previous file records，以复用未变化文件。

## 4. 构建索引

扫描完成后依次构建：

1. symbol 和 import facts。
2. architecture nodes 和 edges。
3. symbol/file relationships。
4. test graph。
5. repository-derived lexical aliases。

各阶段都保留 diagnostics，不把解析失败当成空结果。语言支持、Tree-sitter adapter、架构识别、测试图和 alias 规则见 [parsing-and-relations.md](parsing-and-relations.md)。

Test graph 会接收 previous files、symbols、tests、相关 edges 和 diagnostics。文件身份集合、test/config/resource 内容、test files 的 import 关系及 symbol name/file identity 均等价时，复用 previous test nodes 与 test-owned edges；普通 production body mutation 因此无需重新读取或解析 test files。任一条件无法证明时都保守重建。重建时先建立 imports-by-file、symbols-by-name/file、source stem、resource/snapshot 和 runner configuration lookup，再生成保持稳定排序、evidence、confidence 与 lexical target 的节点和边。

## 5. 合并和提交

关系边经过 coalesce、evidence 去重和稳定排序。随后生成 metadata 和 generation，并以提交操作更新 current pointer。

generation 提交完成前不会成为查询可见状态；查询只读取完整 generation。

## 增量复用

只有在以下条件同时满足时，才完整复用上一 generation：

- 没有新增、修改或删除文件。
- 扫描没有 diagnostics。
- config、ignore fingerprint 和 Git revision 相同。
- 旧 generation 是无 diagnostics 的 `fresh`；或是 diagnostics 全部为绑定到前后相同 indexed content hash 的 `PARSER_SYNTAX_ERROR` 的 `partially_stale`。
- metadata diagnostic count 与 generation payload 一致。

完整复用仍执行扫描、HEAD 二次检查和 progress 收尾，但不运行 graph builders 或 commit，并保留旧 generation 的 freshness、diagnostics 和计数。部分变化时，文件扫描和局部 parser/architecture/test/alias 结果仍可按各自安全条件复用；稳定 syntax diagnostic 随未变化文件保留，瞬态 diagnostic 继续重试。

## 取消和仓库变化

每个耗时阶段检查 AbortSignal。扫描期间如果 HEAD 变化，服务返回 `REPOSITORY_CHANGED_DURING_SCAN`，不会提交可能对应旧工作区的 generation。

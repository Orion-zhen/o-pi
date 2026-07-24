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

## 5. 合并和提交

关系边经过 coalesce、evidence 去重和稳定排序。随后生成 metadata 和 generation，并以提交操作更新 current pointer。

generation 提交完成前不会成为查询可见状态；查询只读取完整 generation。

## 增量复用

只有在以下条件同时满足时，才复用上一 generation：

- 没有新增、修改或删除文件。
- 扫描没有 diagnostics。
- 旧 generation 是 `fresh`。
- config、ignore 和 parser fingerprint 相同。
- Git revision 没有变化。

部分变化时，文件扫描和部分 parser 结果仍可复用，但最终 freshness 可能是 `partially_stale`。

## 取消和仓库变化

每个耗时阶段检查 AbortSignal。扫描期间如果 HEAD 变化，服务返回 `REPOSITORY_CHANGED_DURING_SCAN`，不会提交可能对应旧工作区的 generation。

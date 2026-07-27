# Repo Map Freshness、Generation 与确定性

Repo Map 不直接覆盖当前索引，而是以 generation 的形式保存完整快照，并通过 current pointer 指向可查询快照。

## Generation

generation 包含：

- 文件记录。
- symbols、tests、architecture 和 aliases。
- relationships 和 evidence。
- diagnostics 和 metadata。

ParsedDocument、native syntax tree 和本次构建的 transient syntax facts 不写入 generation。generation 只有完整提交后才对查询可见；旧 generation 可以在 cache 中保留，用于 refresh 复用或故障恢复。

## Freshness 判定

服务比较以下信号：

- Git HEAD revision。
- Repo Map + File Tools config fingerprint。
- ignore fingerprint。
- generation 自身的 partial diagnostics 及其是否可由 content hash 证明稳定。

配置或 ignore fingerprint 不一致时，generation 不能继续标记为 fresh。缓存只接受当前严格数据结构；不提供旧缓存兼容或迁移。

当前唯一可稳定复用的 diagnostic 是带 path 的 `PARSER_SYNTAX_ERROR`：该 path 在 previous/current 中都必须是 `indexed`，且 content hash 相同。`PARSER_ERROR`、`FILE_CHANGED_DURING_PARSE`、读取/扫描错误以及 architecture/test diagnostics 都视为瞬态或依赖更广，必须重试对应流程。

## 状态

| 状态 | 条件 |
| --- | --- |
| `fresh` | 扫描和索引完整，revision、配置和 ignore 一致 |
| `partially_stale` | 有不可读、不稳定、解析或架构 diagnostics，但 generation 可查询 |
| `stale` | revision、配置或 ignore 不一致 |
| `unavailable` | generation、current pointer 或依赖配置无法读取 |

查询 gate 会拒绝 `stale` 和 `unavailable` generation。`partially_stale` 可以查询，但结果必须带有边界信息。

## Refresh 与 rebuild

`refresh` 使用 previous file records、已有 symbol/edge/architecture/test 数据尽量复用未变化内容。变化文件在解析前重新校验 content hash；文件变化、parser failure、worker failure fallback 和 architecture/test diagnostics 不会原子提交为 fresh generation。

完整 generation 快速复用要求没有文件增删改和 scan diagnostics，HEAD、配置及 ignore fingerprint 一致，且 metadata diagnostic count 与 payload 一致。旧 generation 可以是无 diagnostics 的 `fresh`，也可以是 diagnostics 全部满足上述 content-hash 条件的 `partially_stale`。快速复用保留原 freshness、diagnostics、generation ID 和图计数，不会把 partial 状态提升为 fresh。

局部刷新也只携带内容稳定的 syntax diagnostics；瞬态 parser diagnostics 对应文件会重新解析。Test graph 只有在文件身份集合、test/config/resource 内容、test import 关系和 symbol name/file identity 均等价时才整体复用，否则保守重建。

`rebuild` 不读取旧 generation，适用于：

- cache 或 generation 损坏。
- 需要排除旧索引残留。
- refresh 后仍无法恢复一致性。

## 确定性与并发

节点、边、evidence、alias、diagnostics 和 generation cleanup 都使用显式比较器和稳定排序。并发任务完成顺序、local/worker 选择和 worker batch 边界不应改变最终图内容、generation digest 或 query oracle。

worker 只返回可序列化的 file index/syntax facts；worker crash 会在不改变语义的情况下回到 local 分析，AbortSignal 则终止任务并保持取消状态。worker 和临时资源由各 owner 在 abort、timeout、error 与 service 完成后释放，idle worker 不阻止进程退出。主线程 Tree-sitter parser cache 是进程级共享资源，不由单个 grep 或 Repo Map owner 销毁。

generation 的缓存布局、原子提交和损坏校验见 [storage-and-errors.md](storage-and-errors.md)。

## 仓库变化保护

服务在扫描结束时再次读取 HEAD revision。如果仓库在扫描期间变化，会返回 `REPOSITORY_CHANGED_DURING_SCAN`，不会提交对应旧状态的 generation。

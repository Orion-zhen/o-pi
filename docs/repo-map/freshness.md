# Repo Map Freshness、Generation 与确定性

Repo Map 不直接覆盖当前索引，而是以 generation 的形式保存完整快照，并通过 current pointer 指向可查询版本。

## Generation

generation 包含：

- 文件记录。
- symbols、tests、architecture 和 aliases。
- relationships 和 evidence。
- diagnostics。
- metadata 和 fingerprint。

generation 只有完整提交后才对查询可见。旧 generation 可以在 cache 中保留，用于 refresh 复用或故障恢复。

## Freshness 判定

服务比较以下信号：

- Git HEAD revision。
- Repo Map + File Tools config fingerprint。
- ignore fingerprint。
- parser/index format fingerprint。
- generation 自身的 partial diagnostics。

任一关键 fingerprint 不一致，generation 就不能继续标记为 fresh。

## 状态

| 状态 | 条件 |
| --- | --- |
| `fresh` | 扫描和索引完整，所有 fingerprint 一致 |
| `partially_stale` | 有不可读、不稳定、解析或架构 diagnostics，但 generation 可查询 |
| `stale` | fingerprint、revision 或 parser 版本不一致 |
| `unavailable` | generation、current pointer 或依赖配置无法读取 |

查询 gate 会拒绝 `stale` 和 `unavailable` generation。`partially_stale` 可以查询，但结果必须带有边界信息。

## Refresh 与 rebuild

`refresh` 使用 previous file records、已有 symbol/edge/architecture 数据尽量复用未变化内容。`rebuild` 不读取旧 generation，适用于：

- cache 或 generation 损坏。
- schema 或 parser format 变化。
- 需要排除旧索引残留。
- refresh 后仍无法恢复一致性。

## 确定性

节点、边、evidence、alias、diagnostics 和 generation cleanup 都使用显式比较器和稳定排序。并发任务完成顺序不应改变最终图内容或结果顺序。

generation 的缓存布局、原子提交和损坏校验见 [storage-and-errors.md](storage-and-errors.md)。

## 仓库变化保护

服务在扫描结束时再次读取 HEAD revision。如果仓库在扫描期间变化，会返回 `REPOSITORY_CHANGED_DURING_SCAN`，不会提交对应旧状态的 generation。

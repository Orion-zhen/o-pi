# Repo Map 持久化、校验与错误

## Cache 布局

默认缓存位于 `~/.pi/cache/repo-map`，可用 `PI_REPO_MAP_CACHE_DIR` 覆盖：

```text
<cache-root>/<map-id>/
├── CURRENT
├── COMMIT_LOCK/
└── generations/<generation-id>/
    ├── metadata.json
    ├── files.json
    ├── symbols.json
    ├── tests.json
    ├── architecture.json
    ├── aliases.json
    ├── edges.json
    └── diagnostics.json
```

map ID 由 schema major、规范化 worktree root 和 Git common directory 计算。不同 worktree 即使共用 Git common directory，也有不同 map ID。

## Generation ID

generation ID 是稳定快照的 SHA-256，输入包括：

- map ID、schema version。
- Repo Map 与完整 File Tools 配置 fingerprint。
- ignore 和 parser fingerprint。
- 可选 HEAD revision。
- 排序后的 files、symbols、tests、architecture、aliases、edges 和 diagnostics。

时间戳、PID 和随机值不参与 generation ID。相同输入应得到相同 generation；无变化时直接复用已有 generation 目录。

## 原子提交

提交过程：

1. 获取当前 map 的跨进程锁。
2. 写入私有临时 generation 目录。
3. 校验各快照文件。
4. 原子 rename generation 目录。
5. 原子更新 `CURRENT`。
6. 按 `cache.max_generations` 清理旧 generation。

失败、取消或并发竞争不能让半成品成为 current。清理失败也不会回滚刚提交的 generation。

缓存目录尽量使用 `0700`，文件使用 `0600`；map、generation 和 current pointer 必须是真实目录或文件，不能通过 symlink 绕过检查。

## 读取校验

读取缓存时先校验 schema 和 `additionalProperties: false`，再校验：

- canonical absolute root 和安全相对路径。
- map/file/symbol 稳定 ID。
- source range、节点 owner 和 edge endpoint。
- canonical 排序。
- metadata 计数与实际数组。
- generation hash。

任一校验失败都把 generation 视为 unavailable，不部分信任损坏数据。

## 错误

会终止初始化的错误包括：

- `NOT_GIT_WORKTREE`
- `GIT_UNAVAILABLE`
- `CONFIG_ERROR`
- `SCAN_LIMIT_EXCEEDED`
- `OPERATION_ABORTED`
- `CACHE_ERROR`
- `REPOSITORY_CHANGED_DURING_SCAN`

目录不可读、文件不可读、文件不稳定和单文件 parser 失败通常形成 diagnostics，并可能产生 `partially_stale`；配置错误、Git 错误、取消、HEAD 变化和提交错误终止整个事务。

恢复通常是修复原因后执行 `/init refresh`；怀疑旧快照或 parser 复用时执行 `/init rebuild`。缓存损坏不要求手工删除，新的有效 generation 会覆盖 current 指向；无法使用的旧 generation 可以被标记为 corrupt 后清理。

## 明确不做的事

Repo Map 不提供：

- watcher 或后台持续索引。
- embedding、向量数据库、LLM query expansion 或网络服务。
- 编译器级类型解析、动态调用图或完整 module resolution。
- Git history、rename、co-change 或 churn 分析。
- 自动运行测试、自动修改文件或阻止成功 mutation。
- 对 `ls`、命中 exact path 的 `find` 和完整短 `read` 的强制增强。

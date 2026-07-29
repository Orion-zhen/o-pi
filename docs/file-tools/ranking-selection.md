# 排序选择与结果通道

本文说明融合后的候选如何进行 Top-K 选择，以及 `main`、`nearby`、`related` 的区别。证据来源见 [排序证据](ranking-evidence.md)。

## Relevance head 与 MMR

融合候选先按 tier、查询上下文优先级、family-aware RRF、verified coverage 和稳定键完成 relevance 排序。选择器参数集中在 `src/file-tools/grep/ranking.ts`：

- `HEAD_SIZE = 3`：前三条原样保留；limit 小于等于 3 时结果就是 relevance Top-K。
- `lambda = 0.85`。
- 不使用按分数比例删除合格候选的 cutoff；只在当前最佳 tier 内做多样性选择。

剩余名额使用确定性 MMR：

```text
utility = 0.85 * normalizedRelevance
        - 0.15 * maxSimilarityToSelected
```

每一步只在当前最优 tier 内选择，因此多样性不能提升较差 tier。`find` 相似度使用 identity、basename、顶层 component 和 kind；`grep` 使用 identity、symbol、path、candidate role 和 component。相似度只是软惩罚。

MMR 返回确定性的选择顺序，relevance head 保持在最前；不使用按分数比例删除合格候选的 cutoff。

## Main、nearby 与 related

`grep` 的 main 需要正文/本地语义证据、exact qualified symbol、exact symbol，或者查询明确要求的关系角色。Repo Map direct 默认只调整已有候选排序；short symbol、alias、package、component 和普通 export 不能独立进入可见结果。literal/regex 的外部候选只能增强真实文本命中。

显式 caller/callee/reference/test/import/registration/entrypoint 查询允许 direct 或 hop-1 关系进入 main。普通查询只有在主结果为空时才允许可信 hop-1 进入 related；hop-2 永不进入 grep 可见候选。

### nearby

只有主结果为空时，`grep` 才可从当前代码单元生成最多 3 条 symbol edit-distance、部分 query terms 或路径重合建议。`nearby` 明示 `query_match: not_guaranteed`，不参与主结果排序或返回计数。

### related 与全局行动预算

`related` 只承担主结果为空时的 Repo Map hop-1 回退导航。显式关系 main 与 related 共用 `grep_relation_action_limit`，默认全局最多 2 条；预算不随 main 数量增长，并继续受 `grep_result_limit` 和 token budget 约束。来源、hop、confidence、reason、hash 等只保留在 details/telemetry。

## Renderer 与稳定性

`find` renderer 不再按顶层目录二次选择。宽输出的 `top:` 直接取已完成 relevance/MMR 选择的输入前缀；公共目录前缀只做无损文本压缩，路径树只折叠其余结果。

融合扫描为 `O(N)`，identity 合并通常为常数时间；排序为 `O(N log N)`。MMR 缓存每个剩余候选对已选集合的最大相似度，每次选中一条后线性更新，因此 Top-K 阶段为 `O(NK)`，额外空间为 `O(N)`，没有额外 I/O。

稳定顺序使用 path、range、symbol、文本等明确键，不使用文件系统顺序、并发完成顺序或语言服务器返回顺序。

## 验证

`scripts/bench-file-tools-ranking.mjs` 使用独立参考实现校验 head+MMR，覆盖：

- 高相关同文件与低相关跨文件；
- 多来源高/低排名共识；
- hop 竞争；
- exact/reference/test/registration 混合；
- renderer 顺序一致性。

`npm run bench:file-tools:calibration` 会在临时缓存中重建当前工作树的 Repo Map，并执行 path、symbol、literal、regex、caller 和 test intent 查询，报告逐查询 Top-3、MRR、Recall@3 和冷查询耗时。当前门槛为 MRR/Recall@3 `0.95`。

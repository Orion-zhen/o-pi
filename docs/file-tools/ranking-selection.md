# 排序选择与结果通道

本文说明融合后的候选如何进行 Top-K 选择，以及主结果与 `nearby` 的区别。证据来源见 [排序证据](ranking-evidence.md)。

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

MMR 返回确定性的选择顺序，relevance head 保持在最前；不使用按分数比例删除合格候选的 cutoff。`grep` 只在本地 region 与已物化 hint evidence 完成融合后执行一次 MMR，范围是 packer 会优先考虑的 `max(32, grep_result_limit * 4)` 个候选；其余候选保持完整 relevance 顺序，继续参与低成本候选回退。

## 主结果与 nearby

`grep` 的主结果必须来自实时正文或本次 live AST unit。正文命中可以形成 verified region；本地 AST 或映射到 AST 的 position hint 可以形成 exact symbol、natural-language fallback，或者查询明确要求的关系 region。`literal`/`regex` 只允许 verified region。

显式 caller/callee/reference/test/import/registration/entrypoint 查询允许已映射的 LSP 关系进入主结果。

### nearby

只有主结果为空时，`grep` 才可从当前代码单元生成最多 3 条 symbol edit-distance、部分 query terms 或路径重合建议。`nearby` 明示 `query_match: not_guaranteed`，不参与主结果排序或返回计数。

### 显式关系预算

关系主结果受 `grep_relation_action_limit` 限制，默认全局最多 2 条，并继续受 `grep_result_limit` 和 token budget 约束。grep 没有 `related` 通道；hint 的 origin、hop、confidence、reason 和 hash 不进入公开结果。

## Renderer 与稳定性

`find` renderer 不再按顶层目录二次选择。宽输出的 `top:` 直接取已完成 relevance/MMR 选择的输入前缀；公共目录前缀只做无损文本压缩，路径树只折叠其余结果。

融合扫描为 `O(N)`，identity 合并通常为常数时间；排序为 `O(N log N)`。`find` 的 MMR 缓存每个剩余候选对已选集合的最大相似度，Top-K 阶段为 `O(NK)`。`grep` 的完整候选数只影响线性融合与排序；MMR 只处理有界 packer 头部 `P`，成本为 `O(WP²)`，其中 similarity window `W <= 256`、`P <= 200`，没有额外 I/O。

稳定顺序使用 path、range、symbol、文本等明确键，不使用文件系统顺序、并发完成顺序或语言服务器返回顺序。

## 验证

`scripts/bench-file-tools-ranking.mjs` 使用独立参考实现校验 head+MMR，覆盖：

- 高相关同文件与低相关跨文件；
- 多来源高/低排名共识；
- exact/reference/test/registration 混合；
- renderer 顺序一致性。

`scripts/bench-file-tools-search.mjs` 另行覆盖跨 `src`、`tests`、`docs` 和 `agent` 的宽范围 `grep(auto)`，防止完整候选数重新进入 MMR limit。

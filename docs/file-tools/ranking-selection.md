# 排序选择

grep 候选先按以下固定键完成 relevance 排序：

```text
tier
-> BM25F field score
-> fusion score
-> verified coverage
-> role priority
-> region size
-> path
-> start line
-> end line
-> id
```

排序不执行 query 意图分类或 `tests` / `src` 上下文加权。`path` 只在最后破平，不进入来源 rank。

packer 先按 `grep_related_result_limit` 静默保留 relevance 排序中的前 N 个 related/semantic region；verified region 不消耗该配额。总结果选择保留前 4 条 relevance head，剩余名额只在当前最佳 tier 内按 `lambda=0.85` 的确定性 MMR 选择，降低同文件、同 symbol 和同目录重复。MMR 不跨 tier，不设 score cutoff，也不按 token 成本删改候选；选出的 tail 最终恢复 relevance 顺序。

超过总结果限制时，`truncated_by` 加入 `result_limit`，模型正文的 `<grep>` 开始标签同步显示截断状态和省略数量。

`grep_regional_display_limit` 只限制单个 region 的代表行数，不影响 region 选择。`approx_tokens` 只用于观测。

普通正文命中和零命中 related 回退不混排：只要整次调用存在正文命中，就不生成 related 候选。

当前策略以 `tier-bm25f-rrf-mmr-v1` 写入 telemetry。算法标识只描述排序语义，不替代 Git revision。每次调用同时记录纯 relevance 前缀与最终选择的文件数、MMR 替换数，并为可见候选记录 relevance rank、tier、主/辅助分数和 `head` / `mmr` 阶段。

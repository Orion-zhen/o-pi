# 排序选择

grep 候选先按以下固定键完成 relevance 排序：

```text
query tier + authority
-> BM25F field score
-> fusion score
-> verified coverage
-> region size
-> path
-> start line
-> end line
-> id
```

排序不执行 query 意图分类或 `tests` / `src` 上下文加权。每个 query tier 内按 `called`、`referenced`、`defined`、unknown 划分 authority band；`path` 只在最后破平，不进入来源 rank。

结构化多命中和零命中查询优先由 LSP 原子生成 symbol 与 authority。只有 server 同时支持 workspace symbol、document symbol、references 和 incoming call hierarchy，且本次所选 symbol 全部完成映射时才采用 LSP 结果；能力缺失、超时或响应不完整时整次回到 Tree-sitter。

Tree-sitter 路径复用命名代码单元中已经提取的定义、引用、调用和文件级 import，构造一次性的保守依赖图。同文件唯一目标、显式 import 唯一目标或当前解析集唯一 exported 目标才形成边；匿名顶层代码、局部定义遮蔽、同名歧义和动态调用不猜测。该图只更新 `called` / `referenced` / `defined`，不读取目录名、文件名或测试框架字符。

packer 先按 `grep_related_result_limit` 静默保留 relevance 排序中的前 N 个 related/semantic region；verified region 不消耗该配额。总结果选择保留前 4 条 relevance head，剩余名额只在当前最佳 tier 内按 `lambda=0.85` 的确定性 MMR 选择，降低同文件、同 symbol 和同目录重复。MMR 不跨 tier，不设 score cutoff，也不按 token 成本删改候选；选出的 tail 最终恢复 relevance 顺序。

超过总结果限制时，`truncated_by` 加入 `result_limit`，模型正文的 `<grep>` 开始标签同步显示截断状态和省略数量。

`grep_regional_display_limit` 只限制单个 region 的代表行数，不影响 region 选择。`approx_tokens` 只用于观测。

普通正文命中和零命中 related 回退不混排：只要整次调用存在正文命中，就不生成 related 候选。

当前策略以 `semantic-tier-bm25f-rrf-mmr-v2` 写入 telemetry。算法标识只描述排序语义，不替代 Git revision。每次调用同时记录纯 relevance 前缀与最终选择的文件数、MMR 替换数，并为可见候选记录 relevance rank、结构 tier、主/辅助分数和 `head` / `mmr` 阶段。

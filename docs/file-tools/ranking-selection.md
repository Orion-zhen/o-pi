# 排序选择与结果通道

本文说明融合后的候选如何进行 Top-K 选择，以及 `main`、`nearby`、`related` 的区别。证据来源见 [排序证据](ranking-evidence.md)。

## Relevance head 与 MMR

融合候选先按完整 relevance 排序。选择器参数集中在 `ranking-selection.ts`：

- `HEAD_SIZE = 3`：前三条原样保留；limit 小于等于 3 时结果就是 relevance Top-K。
- `lambda = 0.85`。
- 同 tier 动态 cutoff 比例为 `0.30`。

剩余名额使用确定性 MMR：

```text
utility = 0.85 * normalizedRelevance
        - 0.15 * maxSimilarityToSelected
```

每一步只在当前最优 tier 内选择，因此多样性不能提升较差 tier。`find` 相似度使用 identity、basename、顶层 component 和 kind；`grep` 使用 identity、symbol、path、candidate role 和 component。相似度只是软惩罚。

MMR 结束后，tail 恢复完整 relevance 顺序，relevance head 保持在最前。同 tier 候选若 RRF 分数低于该 tier 最佳分数的 30%，会被 cutoff；该 tier 没有有效证据时不截断。

## Main、nearby 与 related

主结果需要直接 path、symbol 或 textual 证据，或者查询明确要求关系角色。轻量 intent 规则识别 caller/callee/reference、test/mock/fixture、registration/entrypoint 等明显 token：

- `login`：definition 为 main；仅图传播得到的 caller/test 为 related。
- `callers of login`：caller 可以进入 main，但仍保持 hop tier 和 graph 弱权重。
- `login tests`：test 关系可以进入 main。
- `literal` / `regex`：只有实时正文命中进入 main；其他可导航结构候选进入 related。

### nearby

只有 fuzzy 主结果为空时，`find` 可从本地 Fuse 建议生成最多 3 条 `nearby`；`grep` 可从当前代码单元生成 symbol edit-distance、部分 query terms 或路径重合建议。

`nearby` 必须明示 `nonmatch` 和单一原因，不参与主结果的 RRF rank、cutoff、limit 或返回计数，也不会触发关系扩展。

### related

`related` 来自 Repo Map 的已验证可导航关系，明示 `query_match: not_guaranteed`，同样不参与主结果的 RRF rank、cutoff 或 limit。

`nearby` 表达本地相似性，`related` 表达代码图关系；两条通道可以同时存在，但不能互相替代或混入 main。

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

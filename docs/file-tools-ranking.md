# 文件工具排序算法

本文说明 `find` 与 `grep` 的候选融合和 Top-K。路径安全、ignore、glob、正文预算见 [文件工具设计](fs-tools.md)，Repo Map 查询见 [Repo Map](repo-map.md)。

## 排序边界

排序器不调用模型、不使用 embedding，也不跨来源比较 Fuse、BM25、LSP 或 Repo Map 原始分数。完整顺序始终是：

```text
tier
  -> family-aware weighted RRF
  -> 必要的 hop / confidence 条件
  -> 稳定路径、range 和文本键
```

`tier` 是离散语义边界。连续证据只能重排同一 tier，不能让 fuzzy、BM25、reference 或 hop 1/2 越过 exact path、exact filename、exact qualified symbol 等直接命中。literal/regex 主候选必须在当前正文中重新命中；纯图关系默认进入 `related`。

scope、ignore、glob、content hash、related-file hash 和 live symbol/range 校验都发生在计算来源 rank 之前。并发完成顺序和来源输入顺序不参与稳定键。

## Family-aware weighted RRF

证据分为四个独立 family：

| family | 来源 |
| --- | --- |
| lexical | path、literal/regex occurrence、BM25/text fallback |
| semantic | LSP workspace symbol 或低权重 reference |
| structural | Tree-sitter definition/symbol、已验证的 Repo Map hop 0 direct evidence |
| graph | Repo Map hop 1/2；本地一跳关系 |

每个有效来源按自身已验证顺序取得一基 rank。贡献公式为：

```text
sourceContribution = sourceWeight * confidence / (60 + sourceRank)
familyContribution = max(sourceContribution in family)
fusionScore = sum(familyContribution)
```

默认权重集中在 `ranking-evidence.ts`：path/text/AST symbol 为 `1.0`，BM25 `0.9`，LSP workspace symbol `0.95`，LSP reference `0.5`，Repo Map direct `0.85`，本地一跳与 Repo Map hop 1 为 `0.35`，hop 2 为 `0.18`。同 family 重复确认只取最大值，因此 AST 与 Repo Map structural 不会双重累计。不同 family 的高排名证据可以形成共识，但多个低排名来源不能自动压过单来源第一名。

固定宽度 `RankingEvidence` 只保存四个 family 的最大贡献、mask、family count、总分和最大贡献；合并与比较均为 `O(1)`，热路径不分配动态证据集合。

## Repo Map 校准

Repo Map 候选必须通过当前文件 content hash；自动模式还保留 related-file hash gate。没有实时 freshness 证明的候选不进入主结果，也不提供 RRF 贡献。

- hop 0 且 confidence `>= 0.5`、具有直接 path/symbol/definition/architecture 理由时，进入 structural family；贡献仍乘 candidate confidence。
- hop 0 低 confidence 可保留召回，但不形成独立 structural family。
- hop 1/2 只进入 graph family，分别使用低权重；还要乘 candidate confidence、edge confidence 和 resolution 系数。semantic/syntactic/lexical resolution 系数依次为 `1/0.9/0.65`。
- graph 候选不继承 seed 的 exact symbol tier。二跳只补充召回。

Repo Map 查询层顺序在实时验证后重新编号。main 与 related 分开编号，因此增加 related 候选不会稀释 main 的 RRF rank。

文件候选投影到代码区域时依次尝试 candidate symbol ID、candidate range、alias/evidence 名称、查询 token 最匹配的 unit。无法定位时不会使用 `units[0]`：候选转为文件级 related，避免把任意首个函数伪装为目标。

## 来源内部顺序

### find path

路径来源内部使用 exact normalized path、exact basename/stem、segment/prefix、substring、Fuse 的既有离散 tier。未声明 test/spec/fixture/mock 意图时，测试路径的 fuzzy 候选降至下一 tier；明确测试意图仍优先测试路径。Fuse 原始分数只用于 path 来源内部顺序，之后转换为 RRF rank。

### Tree-sitter / text

Tree-sitter/text 按 tier、来源内 BM25、真实命中行数、路径 token、region 大小及稳定范围排序。definition/symbol 提供 structural family；实时 occurrence 提供 lexical family；同一 region 可同时获得两个 family，但每个 family 仍只保留最大贡献。

### LSP

LSP 不依赖语言服务器返回顺序。通过 scope 和正文读取后显式排序：

```text
exact qualified symbol
  -> exact symbol
  -> prefix/token match
  -> fuzzy workspace symbol
  -> reference
```

`FileToolLspSymbolCandidate.origin` 区分 `workspace-symbol` 和 `reference`；旧适配未提供时按 workspace symbol 处理。reference 使用更差 tier 和更低 source weight。最终以 symbol、path 和 range 稳定打破平局。

## Region identity

有 symbol 的 `grep` 候选按 path、normalized qualified symbol、kind、signature 和 range 聚类合并。Tree-sitter、LSP、Repo Map 的范围重叠或起始行相差不超过两行时可视为同一 region；若双方 signature 明确且不同，则保持为不同 overload。无 symbol 的文本 region 继续使用严格 ID/range。

## Relevance head 与 MMR

融合候选先按完整 relevance 排序。选择器参数集中在 `ranking-selection.ts`：

- `HEAD_SIZE = 3`：前三条原样保留；limit 小于等于 3 时结果就是全局 relevance Top-K。
- `lambda = 0.85`。
- 同 tier 动态 cutoff 比例为 `0.30`。

剩余名额使用确定性 MMR：

```text
utility = 0.85 * normalizedRelevance
        - 0.15 * maxSimilarityToSelected
```

每一步只在当前最优 tier 内选择，因此多样性不能提升较差 tier。`find` 相似度使用 identity、basename、顶层 component 和 kind；`grep` 使用 identity、symbol、path、candidate role、component。相似度只是软惩罚。MMR 选择结束后，tail 恢复完整 relevance 顺序，relevance head 保持在最前。

同 tier 候选若 RRF 分数低于该 tier 最佳分数的 `30%` 会被 cutoff；该 tier 全部无有效证据时不截断。这样不会为了填满 limit 返回极低质量的长尾，同时保留没有可量化 RRF 的明确离散候选。

`find` renderer 不再按顶层目录二次选择。宽输出的 `top:` 直接取已完成 relevance/MMR 选择的输入前缀；公共目录前缀只做无损文本压缩，路径树只折叠其余结果。

## Main、nearby 与 related

主结果需要直接 path、symbol、textual 证据，或查询明确要求关系角色。轻量 intent 规则识别 caller/callee/reference、test/mock/fixture、registration/entrypoint 等明显 token：

- `login`：definition 为主；仅图传播得到的 caller/test 为 related。
- `callers of login`：caller 可以进入主结果，但仍保持 hop tier 和 graph 弱权重。
- `login tests`：test 关系可以进入主结果。
- literal/regex：只有实时正文命中进入主结果；其他可导航结构候选留在 related。

只有主结果具有直接命中语义。主结果为空时，`find` 可从本地 Fuse 建议或 glob 外路径生成最多 3 条 `nearby`；`grep` 可从当前代码单元生成 symbol edit-distance、部分查询词或路径重合建议。`nearby` 明示 `nonmatch` 和单一原因，不参与主结果的 RRF rank、cutoff、limit 或返回计数，也不会触发关系扩展。

`related` 来自 Repo Map 的已验证可导航关系，明示 `query_match: not_guaranteed`，同样不参与主结果的 RRF rank、cutoff 或 limit。`nearby` 表达本地相似性，`related` 表达代码图关系；两条通道可同时存在，但不能互相替代或混入 main。

## 确定性与复杂度

融合扫描为 `O(N)`，identity 合并通常为常数时间；同 symbol bucket 只比较少量 range。排序为 `O(N log N)`。MMR 缓存每个剩余候选对已选集合的最大相似度，每次选中一条后线性更新，因此 Top-K 阶段为 `O(NK)`、额外空间 `O(N)`；没有额外 I/O。

`scripts/bench-file-tools-ranking.mjs` 用独立参考实现校验 head+MMR，并固定覆盖高相关同文件与低相关跨文件、多来源高/低排名共识、hop 竞争、exact/reference/test/registration 混合，以及 renderer 顺序一致性。

`npm run bench:file-tools:calibration` 会在临时缓存中为当前 `o-pi` 工作树重建 Repo Map，并执行路径、symbol、literal、regex、caller 与 test intent 的固定人工相关性查询。它报告逐查询 Top-3、MRR、Recall@3 和冷查询耗时，并以 `0.95` 作为 MRR/Recall@3 回归门槛；临时 generation 在退出时删除。当前校准暴露并修复了“普通实现查询被同名测试文件的多来源共识反超”的问题。

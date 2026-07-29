# 搜索排序总览

本文是 `find` 和 `grep` 排序的入口。路径安全、ignore、glob 和正文预算分别见 [路径与安全](path-security.md)、[Ignore engine](ignore.md) 和 [工具契约](contracts.md)。

## 排序流水线

候选不会按并发完成顺序直接返回，而是经过固定流水线：

```text
scope / ignore / glob / freshness 校验
    ├─ find: path 召回与排序
    └─ grep: 正文候选
             → live AST 折叠、结构补充与区域合并
             → 按需位置 hint / 显式关系 AST 回退
    → 离散 relevance tier
    → family-aware evidence fusion
    → identity 去重与 region 合并
    → 主结果
    → 稳定 Top-K 和模型输出
```

排序器不调用模型、不使用 embedding，也不跨来源比较 Fuse 或 LSP 原始分数。scope、ignore、glob 和 live AST range/unit 校验都在计算 hint 来源 rank 之前完成。

## Tier 优先

`tier` 是离散语义边界。连续证据只能重排同一 tier，不能让 lexical anchor 或 reference 越过 exact path、exact filename、exact qualified symbol 等直接命中。

`literal` 和 `regex` 的主候选必须在当前正文中命中，并且不调用 LSP。`auto` 普通查询也只接受正文 hit/anchor 产生的候选；Tree-sitter 只能改变区域表示和补充结构。精确 symbol 歧义时的 hint 必须映射并合并到本次 live AST unit。显式关系查询先请求 LSP，没有有效结果时才启用 AST relation fallback。

## 证据来源

grep 证据分为四个独立 family：

| family | 来源 |
| --- | --- |
| factual | 当前正文的 literal/regex occurrence |
| lexical | 正文 lexical anchor |
| semantic | 映射到 live AST 的 LSP hint |
| graph | 本地一跳关系 |

同一 family 中重复确认只取最大贡献；不同 family 的高排名证据可以形成共识，但多个低排名来源不能自动压过单来源第一名。

完整公式、权重、来源内部顺序和 region identity 见 [排序证据](ranking-evidence.md)。

## 结果通道

主结果需要正文证据，或者查询明确要求关系角色。symbol tier 来自正文候选与 AST 补充名称的共同确认，不是独立 AST 候选。`caller`、`callee`、`reference`、`test`、`registration` 和 `entrypoint` 等 intent 会影响允许进入主结果的关系角色。

grep 只返回真正满足查询语义的 verified/semantic region，不提供 AST nearby、fuzzy 或结构关系非命中通道；无显式关系意图的 caller/test/import 候选不能进入结果。

## 最终选择

融合候选先按完整 relevance 排序。前三条 relevance head 原样保留；剩余名额使用确定性 MMR，在不提升较差 tier 的前提下减少相似结果。`grep` 只在最终 packer 的有界候选头部执行一次 MMR；选择结束后 tail 恢复完整 relevance 顺序。

`find` renderer 不再按顶层目录二次选择；宽输出的 `top:` 直接使用已完成 relevance/MMR 选择的前缀，公共目录前缀只做无损文本压缩。

具体 `HEAD_SIZE`、lambda、cutoff、相似度和复杂度见 [排序选择](ranking-selection.md)。

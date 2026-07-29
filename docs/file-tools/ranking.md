# 搜索排序总览

本文是 `find` 和 `grep` 排序的入口。路径安全、ignore、glob 和正文预算分别见 [路径与安全](path-security.md)、[Ignore engine](ignore.md) 和 [工具契约](contracts.md)。

## 排序流水线

候选不会按并发完成顺序直接返回，而是经过固定流水线：

```text
scope / ignore / glob / freshness 校验
    ├─ find: path 召回与排序
    └─ grep: 正文候选
             → live AST 折叠、结构补充与区域合并
             → 零命中词项回退 / 按需 LSP symbol hint
    → 离散 relevance tier
    → BM25F 字段相关性
    → family-aware evidence fusion
    → identity 去重与 region 合并
    → relevance head + 同 tier MMR
    → 模型输出
```

排序器不调用模型、不使用 embedding，也不跨来源比较 Fuse 或 LSP 原始分数。scope、ignore、glob 和 live AST range/unit 校验都在计算 hint 来源 rank 之前完成。

## Tier 优先

`tier` 是离散语义边界。连续证据只能重排同一 tier，不能让 lexical anchor 或 reference 越过 exact path、exact filename、exact qualified symbol 等直接命中。

`grep` 的 verified 候选必须在当前正文中命中；Tree-sitter 只能改变区域表示和补充结构。整次零正文命中时才允许机械词项和 LSP workspace symbol 形成 related 候选。精确 symbol 歧义时的 hint 必须映射并合并到本次 live AST unit。grep 不解释关系意图，也不接收 LSP reference。

## 证据来源

grep 证据分为三个独立 family：

| family | 来源 |
| --- | --- |
| factual | 当前正文的 regex occurrence |
| lexical | 正文 lexical anchor |
| semantic | 映射到 live AST 的 LSP hint |

同一 family 中重复确认只取最大贡献；不同 family 的高排名证据可以形成共识，但多个低排名来源不能自动压过单来源第一名。

完整公式、权重、来源内部顺序和 region identity 见 [排序证据](ranking-evidence.md)。

## 结果通道

存在正文命中时只返回 verified region；Tree-sitter 聚合范围并补充结构，LSP 只参与多个精确 symbol 的位置消歧。

整次零正文命中时，固定词项覆盖和 LSP workspace symbol 可以形成明确标记的 related semantic region。grep 不分类自然语言或关系意图，也不生成 caller、callee、reference 等关系候选。

## 最终选择

融合候选先按完整 relevance 排序。`grep` 先静默应用 `grep_related_result_limit`，再保留 relevance head，并只在同 tier 的剩余候选中用确定性 MMR 减少重复；离散 tier 不会被多样性跨越。`find` 继续使用自己的确定性 MMR。

`find` renderer 不再按顶层目录二次选择；宽输出的 `top:` 直接使用已完成 relevance/MMR 选择的前缀，公共目录前缀只做无损文本压缩。

具体 `HEAD_SIZE`、lambda、cutoff、相似度和复杂度见 [排序选择](ranking-selection.md)。

# 搜索排序总览

本文是 `find` 和 `grep` 排序的入口。路径安全、ignore、glob 和正文预算分别见 [路径与安全](path-security.md)、[Ignore engine](ignore.md) 和 [工具契约](contracts.md)。

## 排序流水线

候选不会按并发完成顺序直接返回，而是经过固定流水线：

```text
scope / ignore / glob / freshness 校验
    ├─ find: path 召回与排序
    └─ grep: 正文候选
             → 按需 LSP symbol 分析，或 Tree-sitter 折叠
             → 零命中 related 回退
    → query tier + symbol authority
    → BM25F 字段相关性
    → family-aware evidence fusion
    → identity 去重与 region 合并
    → relevance head + 同 tier MMR
    → 模型输出
```

排序器不调用模型、不使用 embedding，也不跨来源比较 Fuse 或 LSP 原始分数。scope、ignore、glob 和 snapshot 校验都在 symbol 分析之前完成。

## Tier 优先

`tier` 是离散语义边界。连续证据只能重排同一 tier，不能让 lexical anchor 越过 exact path、exact filename、exact qualified symbol 等直接命中。

`grep` 的 verified 候选必须在当前正文中命中。每个 query tier 内再按 `called`、`referenced`、`defined`、unknown 划分 authority band。LSP 通过 incoming calls 和 references 提供 authority；Tree-sitter 只确认本地定义。整次零正文命中时才允许机械词项或 LSP 选中的 symbol 形成 related 候选。

## 证据来源

grep 检索证据分为两个独立 family：

| family | 来源 |
| --- | --- |
| factual | 当前正文的 regex occurrence 或 evidence-gated exact literal occurrence |
| lexical | 正文 lexical anchor |

同一 family 中重复确认只取最大贡献；不同 family 的高排名证据可以形成共识，但多个低排名来源不能自动压过单来源第一名。LSP authority 是离散结构证据，不参与来源融合。

完整公式、权重、来源内部顺序和 region identity 见 [排序证据](ranking-evidence.md)。

## 结果通道

存在正文命中时只返回 verified region；简单查询直接使用文本/Tree-sitter。结构化 query 存在多个命中时，LSP 可接管代码单元解析，并按外部调用和引用提升其 authority。

整次零正文命中时，固定词项覆盖和 LSP workspace symbol 可以形成明确标记的 related region。grep 不分类自然语言或路径语义；caller/reference 只用于判断所选定义的 authority，不作为单独结果类型。

## 最终选择

融合候选先按完整 relevance 排序。`grep` 先静默应用 `grep_related_result_limit`，再保留 relevance head，并只在同 tier 的剩余候选中用确定性 MMR 减少重复；离散 tier 不会被多样性跨越。`find` 继续使用自己的确定性 MMR。

`find` renderer 不再按顶层目录二次选择；宽输出的 `top:` 直接使用已完成 relevance/MMR 选择的前缀，公共目录前缀只做无损文本压缩。

具体 `HEAD_SIZE`、lambda、cutoff、相似度和复杂度见 [排序选择](ranking-selection.md)。

# 排序证据与来源

本文说明 `find` / `grep` 如何生成、校准和融合候选证据。总体流水线见 [排序总览](ranking.md)。

## Family-aware weighted RRF

证据分为五个独立 family：

| family | 来源 |
| --- | --- |
| factual | 当前正文的 literal/regex occurrence |
| symbol | Tree-sitter definition/symbol |
| lexical | path、BM25 与 text fallback |
| semantic | LSP symbol/reference 与已验证的 Repo Map direct evidence |
| graph | Repo Map hop 1/2 与本地一跳关系 |

每个有效来源按自身已验证顺序取得一基 rank：

```text
sourceContribution = sourceWeight * confidence * hopFactor / (60 + sourceRank)
familyContribution = max(sourceContribution in family)
fusionScore = sum(familyContribution)
```

权重集中在 `src/file-tools/grep/ranking.ts`，并按 strict、identifier、qualified symbol、long text、natural language 和 relation 查询策略分别校准。`RankingEvidenceSummary` 只保存五个 family 的最大贡献、family count、总分和最大贡献。

单 identifier 已获得 exact symbol 时，同一正文派生的 lexical 证据仍可展示，但不再作为独立 family 累加；它不是相对于 symbol/literal 的独立共识。

## Repo Map 校准

Repo Map 候选必须通过当前文件 content hash；自动模式还保留 related-file hash gate。没有实时 freshness 证明的候选不进入主结果，也不提供 RRF 贡献。

- hop 0 且 confidence `>= 0.5`，并具有直接 path/symbol/definition/architecture 理由时，进入 structural family；贡献仍乘 candidate confidence。
- hop 0 低 confidence 可以保留召回，但不形成独立 structural family。
- hop 1/2 只进入 graph family，分别使用低权重；还要乘 candidate confidence、edge confidence 和 resolution 系数。
- semantic/syntactic/lexical resolution 系数依次为 `1/0.9/0.65`。
- graph 候选不继承 seed 的 exact symbol tier；二跳只补充召回。

每个独立来源先在完整 scope+glob inventory 内查询，再在实时验证后重新编号。main 与 related 分开编号，因此增加 related 候选不会稀释 main 的 RRF rank；外部候选不受本地 parse/semantic Top-K 门控。

文件候选投影到代码区域时依次尝试 candidate symbol ID、candidate range、alias/evidence 名称和查询 token 最匹配的 unit。无法定位时不会使用 `units[0]`；候选转为文件级 related，避免把任意首个函数伪装成目标。

## 来源内部顺序

### `find` path

路径来源依次使用 exact normalized path、exact basename/stem、segment/prefix、substring 和 Fuse 的离散 tier。未声明 test/spec/fixture/mock 意图时，测试路径 fuzzy 候选降至下一 tier；明确测试意图仍优先测试路径。Fuse 原始分数只用于 path 来源内部顺序，之后转换为 RRF rank。

### Tree-sitter / text

Tree-sitter/text 按 tier、来源内 BM25、真实命中行数、路径 token、region 大小及稳定范围排序。definition/symbol 提供 symbol family；实时 occurrence 提供 factual family。同一 region 可以同时获得多个 family，但每个 family 仍只保留最大贡献。

### Symbol 语义与测试上下文

exact/prefix 不信任检索来源的自报标签，由 ranker 根据规范化查询和候选名称统一推导：

- 裸 identifier 只与叶子 symbol 比较；
- qualified symbol 与完整 qualified name 比较；
- qualified query 只有叶子相等时是 exact member；
- prefix 始终检查叶子名称，不会被 qualified name 遮蔽。

普通 identifier/qualified 查询对 `test` role 施加有界上下文 tier 惩罚，使生产 direct/prefix 候选可以超过测试中的偶然同名声明；测试候选不会被过滤。显式 test/spec 意图取消该惩罚，并由 requested relation tier 提升测试候选。该规则只依赖 role，不硬编码 `src/`、`lib/` 或 `packages/` 路径。

### LSP

LSP 不依赖语言服务器返回顺序，通过 scope 和正文读取后显式排序：

```text
exact qualified symbol
    → exact symbol
    → prefix/token match
    → fuzzy workspace symbol
    → reference
```

grep-local `GrepSymbolCandidate.origin` 区分 `workspace-symbol` 和 `reference`；port 未提供 origin 时按 workspace symbol 处理。reference 使用更差 tier 和更低 source weight。最终以 symbol、path 和 range 稳定打破平局。

## Region identity

有 symbol 的 `grep` 候选按 path、normalized qualified symbol、kind、signature 和 range 聚类合并。Tree-sitter、LSP、Repo Map 的范围重叠或起始行相差不超过两行时可视为同一 region；如果双方 signature 明确且不同，则保持为不同 overload。

无 symbol 的文本 region 继续使用严格 ID/range。所有来源的合并、去重和最终比较都不依赖并发完成顺序或来源输入顺序。

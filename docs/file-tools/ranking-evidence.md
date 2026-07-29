# 排序证据与来源

本文说明 `find` / `grep` 如何生成、校准和融合候选证据。总体流水线见 [排序总览](ranking.md)。

## Family-aware weighted RRF

证据分为四个独立 family：

| family | 来源 |
| --- | --- |
| factual | 当前正文的 literal/regex occurrence |
| lexical | 正文 lexical anchor |
| semantic | 映射到 live AST unit 的 LSP hint evidence |
| graph | 本地一跳关系 |

每个有效来源按自身已验证顺序取得一基 rank：

```text
sourceContribution = sourceWeight * confidence / (60 + sourceRank)
familyContribution = max(sourceContribution in family)
fusionScore = sum(familyContribution)
```

权重集中在 `src/file-tools/grep/ranking.ts`，并按 strict、identifier、qualified symbol、long text、natural language 和 relation 查询策略分别校准。`RankingEvidenceSummary` 只保存四个 family 的最大贡献和总分。

单 identifier 已由正文 hit 与 AST 名称共同确认 exact symbol 时，同一正文派生的 lexical 证据仍可展示，但不再重复计入融合分数。

## 来源内部顺序

### `find` path

路径来源依次使用 exact normalized path、exact basename/stem、segment/prefix、substring 和 Fuse 的离散 tier。未声明 test/spec/fixture/mock 意图时，测试路径 fuzzy 候选降至下一 tier；明确测试意图仍优先测试路径。Fuse 原始分数只用于 path 来源内部顺序，之后转换为 RRF rank。

### Tree-sitter / text

正文 hit/anchor 先产生候选。Tree-sitter 只将其折叠到最小 code unit，补充 range、kind、symbol、qualified symbol、declaration 和 roles，并按 unit identity 合并；它不产生 symbol 或 lexical evidence。exact symbol tier 由候选文本和补充后的名称共同确认。显式关系查询没有有效 LSP 结果时，`ast-relation` 才提供 graph evidence。

### Symbol 语义与测试上下文

exact/prefix 不信任检索来源的自报标签，由 ranker 根据规范化查询和候选名称统一推导：

- 裸 identifier 只与叶子 symbol 比较；
- qualified symbol 与完整 qualified name 比较；
- qualified query 只有叶子相等时是 exact member；
- prefix 始终检查叶子名称，不会被 qualified name 遮蔽。

普通 identifier/qualified 查询对 `test` role 施加有界上下文 tier 惩罚，使生产 direct/prefix 候选可以超过测试中的偶然同名声明；测试候选不会被过滤。显式 test/spec 意图取消该惩罚，并由 requested relation tier 提升测试候选。该规则只依赖 role，不硬编码 `src/`、`lib/` 或 `packages/` 路径。

### LSP

LSP 不是常驻召回通道。只有多个本地 exact definition 需要位置消歧，或查询明确要求关系时才请求；普通唯一 symbol 和 strict 查询不启动 LSP。

workspace symbol/reference 经过 scope allowed paths 和 LSP 自身稳定合并后，只作为 path/range hint 进入 grep。LSP symbol hint 必须映射并合并到名称精确匹配查询的 live AST unit；reference hint 必须映射到用户请求的关系角色。hint 的来源内 rank、confidence 和 origin 只提供内部 semantic contribution。

## Region identity

有 symbol 的 `grep` region 以本次 AST unit ID 为身份。LSP range 只选择包含该范围的最小 live unit，随后按该 unit ID 与已有正文 region 合并；外部 symbol、kind 或 signature 不参与公开 identity。

无 symbol 的文本 region 继续使用严格 ID/range。hint 按 origin、path、range 和 relation 去重；最终比较不依赖并发完成顺序。

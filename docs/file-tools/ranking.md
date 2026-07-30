# 搜索排序总览

`find` 和 `grep` 共用 filesystem scope、ignore、glob 和安全边界，但排序目标不同：

```text
scope / ignore / glob
    ├─ find: fzf extended query
    │        -> path-scheme dynamic-programming score
    │        -> deterministic path tie-break
    │        -> result/output limits
    └─ grep: verified text candidates
             -> LSP or Tree-sitter regions
             -> query tier + authority + BM25F/evidence
             -> relevance head + same-tier MMR
```

## `find`

`find` 只对 scope-relative path 排名。普通 query term 是 fuzzy subsequence，多 term 为 AND，`|` 为 OR，并支持 exact、boundary、prefix、suffix 和 inverse operator。每个 term 独立 smart case。

`fzf-v2-path-v1` 使用动态规划选择最高分字符对齐。连续字符、path/word/camelCase 边界获得奖励，gap 受到惩罚；同分时优先 basename 命中、短 span、短路径、scope 顺序和稳定 path。query term 的 Unicode/case 形式在扫描候选前预编译。它不执行 query 意图分类，不读取正文，不使用 embedding、LSP、Tree-sitter、evidence fusion 或 MMR。

每个唯一候选在 discovery 产出时立即进入有界 ranker；result limit 只限制保留的 relevance 前缀，扫描仍继续统计完整命中数。runtime 不物化完整候选数组，不做全量排序或目录多样化。renderer 直接输出具体路径，不折叠候选或二次选择。

## `grep`

`grep` 的 verified 候选必须在当前正文中命中。每个 query tier 内按 `called`、`referenced`、`defined`、unknown 划分 authority band；整次零正文命中时才允许机械词项或 LSP symbol 形成 related 候选。

grep 的 factual/lexical evidence、BM25F 字段分数和 LSP authority 见 [排序证据](ranking-evidence.md)。related cap、relevance head 和同 tier MMR 见 [排序选择](ranking-selection.md)。

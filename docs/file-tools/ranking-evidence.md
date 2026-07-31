# 排序证据与来源

本文说明 `grep` 如何生成候选证据和来源局部 rank。`find` 使用独立的 fzf path score，不进入该链路。

## grep 来源

| 来源 | 用途 |
| --- | --- |
| `text-literal` | 非法正则经 evidence gate 接受后的 exact literal 正文命中 |
| `text-regex` | 当前正文的逐行正则命中 |
| `text-lexical` | 整次零正文命中时的词项 related 回退 |

正文命中与 lexical related 不会在同一次调用中混合；一个候选因此最多携带一个来源。来源按自身相关性取得一基 rank：

```text
sourceScore = sourceWeight / (60 + sourceRank)
```

固定权重集中在 `src/file-tools/grep/ranking.ts`。

来源 rank 和稳定顺序严格分离：

- 所有 literal/正则命中都只是同等的事实准入，`text-literal` / `text-regex` rank 固定为 1；
- lexical 质量形成自身的相关性 rank；
- 等相关候选共享 rank，path/range/id 只负责确定性破平。

因此辅助分数只反映真实来源内的检索排序，不会把按路径遍历的位置误当成相关性。

## 字段相关性

同一 tier 内先按 BM25F 风格字段分数排序。查询词项固定投影到以下字段：

| 字段 | 权重 | 长度归一化 |
| --- | ---: | ---: |
| 叶子 symbol | 8 | 0 |
| qualified symbol / owner | 6 | 0.2 |
| path | 5 | 0.3 |
| declaration / signature | 3 | 0.5 |
| 命中行或 related evidence line | 1 | 0.75 |

IDF 只在本次合格候选集合内计算。字段分数表达 query 与候选结构的相关性；来源分数只负责同一来源内的局部 rank。LSP 关系是结构 authority，不伪装成检索来源。

## Tree-sitter / text

正文 hit 先产生 verified 候选。LSP symbol 模式未启用时，Tree-sitter 只将其折叠到最小 code unit，补充 range、kind、symbol、qualified symbol、declaration 和本地 `defined` authority，并按 unit identity 合并。

整次零正文命中时，扫描阶段保存的机械词项 anchor 才能产生 lexical related 候选。多个词项采用固定覆盖率，不区分自然语言、长文本或 symbol query。

## Symbol

exact/prefix 由 ranker 根据 query 和 analyzer 生成的规范 symbol 名称统一推导：

- 裸名称与叶子 symbol 比较；
- qualified 名称与完整 qualified name 比较；
- qualified query 的叶子相等可形成 exact member；
- prefix 检查叶子名称。

不含正则操作符的名称或路径查询还会机械产生结构词项覆盖信号。symbol 和 path 的完整词项覆盖属于 tier 证据；它不解释自然语言意图，也不对 `src`、`tests` 等目录名赋予先验偏好。

## LSP authority

只要本次全部结构目标和所需能力可用，LSP 可接管任意合法 query 的 symbol 分析：

- workspace symbol 选择本次 inventory 内的有界候选；
- document symbol 直接生成 range、kind、symbol、qualified symbol 和 declaration；
- 候选范围外的 incoming call 将 authority 设为 `called`；
- 没有外部 call 但存在候选范围外的 reference 时设为 `referenced`；
- 否则保持 `defined`。

LSP 只通过调用方提供的 snapshot-bound loader 获得正文。它的 authority 进入离散结构 tier，不进入来源分数。任一所需能力不可用时，整次事务回退 Tree-sitter。

## 路径上下文

grep 排序不读取 `src`、`tests`、`spec`、fixture 或 mock 等路径含义。输出中的 roles 只由 `definition` / `enclosing` 和 authority 派生，不包含路径分类。

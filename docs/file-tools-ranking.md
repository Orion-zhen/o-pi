# 文件工具排序算法

本文是 `find` 与 `grep` 排序行为的唯一详细说明。工具参数、路径安全、ignore、输出格式和预算边界见 [文件工具设计](fs-tools.md)；Repo Map 自身的查询与图传播见 [Repo Map](repo-map.md)。

## 目标与边界

排序器不训练或调用额外模型，也不尝试校准 Fuse、BM25、LSP 与 Repo Map 的原始分数。它只要求每个来源给出自身可信的候选顺序，再用无量纲排名和离散语义等级融合。

核心约束：

- 严格语义边界优先于连续相关性，例如精确路径永远先于 fuzzy path；
- 原始分数只在产生它的来源内部使用，不跨来源相加；
- 独立证据家族可以形成共识，相关或重复证据不能重复放大候选；
- scope、ignore、glob、content hash 和实时 symbol 校验发生在百分位计算之前；
- 并发完成顺序、文件系统枚举顺序和 locale 不影响最终结果；
- Repo Map 或 LSP 不可用时，其候选直接缺席；parser 不可用时只缺失结构信息，并为对应文件启用文本 lexical 降级。其他来源的内部顺序不变。

整体执行链：

```text
候选生成
  -> scope / glob / hash / live symbol 校验
  -> 赋予离散语义等级并在各来源独立排序
  -> 来源内百分位
  -> 单次按 path 或 region identity 合并
  -> 有界选择器按等级、证据共识与稳定键比较
  -> 两轮多样性 Top-K 与输出预算
```

## 候选来源与职责

| 来源 | 证据来源名 | 家族 | 作用 |
| --- | --- | --- | --- |
| `find` 路径索引 | `path` | lexical | exact path/name、segment、substring、token 和 fuzzy path。 |
| `grep` 文本 fallback | `text` | lexical | parser 不支持或 code unit 外的真实 literal/regex 行窗口。 |
| Tree-sitter code index | `ast` | structural 或 lexical | 提供实时 code-unit 边界、symbol/definition、signature 和 occurrence；symbol 类理由属于 structural，普通 occurrence/BM25 属于 lexical。 |
| LSP workspace symbols | `lsp` | semantic | 仅为 symbol-like `grep auto` 查询补充 semantic symbol 候选。 |
| Repo Map | `repo-map` | structural | 为 `find` 和 `grep` 补充已验证的跨文件 symbol、alias、架构和图关系。 |

Tree-sitter 不执行跨文件语义解析；LSP 不参与 `find`；Repo Map 不提供缓存正文，候选最终都由当前文件系统内容验证。某个文件的 Tree-sitter grammar 不支持、runtime 缺失或解析失败时，`grep auto` 在该文件上改用实时正文：连续查询文本为 tier 4，满足 token 覆盖的 lexical 行窗口为 tier 5；不会伪造 symbol、definition 或关系证据。

## 来源内百分位

实时校验后，一个来源剩余 `n` 个候选。零基序号为 `i` 的候选转换为：

```text
percentile(i, n) = 1                         n <= 1
percentile(i, n) = 1 - i / (n - 1)          n > 1
```

因此第一名为 `1`，最后一名为 `0`。百分位只表达来源内顺序，不声称两个来源的原始相关性分数具有相同尺度。

概念上，每条来源证据包含 `source`、`family`、`percentile` 和简短 `reason`。实现中，展示原因由候选的 `reasons` 保留；排序热路径只保存三个家族的存在位和最佳百分位，避免比较时重建集合。合并同一候选时：

1. 相同 `source + reason` 只保留最高百分位；
2. 每个证据家族只取该家族的最高百分位；
3. 在候选语义等级相同时，先比较非空独立家族数；
4. 再比较各家族最佳百分位的中位数；
5. 再比较最佳家族百分位。

这使同一语义等级内的 lexical + semantic 共识优先于单一 lexical 来源，同时保证向同一家族加入较弱证据不会降低或虚增候选。

## `find`

### 路径来源内排序

路径按 `/`、`.`、`-`、`_`、camelCase、PascalCase 和字母/数字边界切词。全小写查询不区分大小写；查询含大写时启用 smart case，大小写冲突的名称命中降一个等级。

存在名称或路径硬命中时，它们作为主候选，Fuse 只生成 nearby suggestions。没有硬命中时，Fuse 候选必须满足阈值和主要 token 覆盖才进入主结果。Fuse 原始分数只在路径来源内参与以下比较：测试意图、smart case、精确 token 数、token 覆盖、Fuse 顺序和稳定路径键。

### 语义等级

数字越小越优先：

| 等级 | 候选 |
| --- | --- |
| 0 | exact normalized path；Repo Map exact path。 |
| 1 | exact basename/stem；Repo Map exact filename。 |
| 2 | exact segment、basename prefix；Repo Map hop 0 exact qualified/exact symbol。 |
| 3 | basename/path substring；Repo Map path match。 |
| 4 | fuzzy path；Repo Map 其他 hop 0 直接关系。 |
| 6 | Repo Map hop 1。 |
| 7 | Repo Map hop 2。 |

Repo Map 只有 hop 0 且带可导航结构理由的候选产生 structural 共识证据。hop 1/2 可以补充召回，但不会继承 seed 的精确 symbol 地位。

同一路径候选合并后取最优等级并合并证据。候选依次比较：等级、证据共识、较短路径、较浅深度、字典序。

### 结果多样性

超过 `find_result_limit` 时执行两轮确定性选择：

1. 按完整相关性顺序为每个顶层目录选择一个候选；
2. 再按完整顺序填满剩余名额；
3. 输出所选子集时恢复其原始相关性顺序。

宽结果的 `Top matches` 使用同一目录覆盖原则，未展开部分再按路径树折叠。

## `grep`

### Tree-sitter/text 来源内排序

`literal` 与 `regex` 先逐行预筛，只解析真实命中文件；`auto` 构建 code index，用 symbol、occurrence、BM25、路径 token 和一跳 caller/callee/import 产生候选。parser 不可用的文件只产生 exact-text 或 token-coverage 文本窗口，并保持 lexical 家族。

Tree-sitter/text 来源内依次比较：语义等级、BM25、真实命中行数、路径 token 重合、较小 region、路径和行号。此处的 BM25 与 token overlap 不离开本来源。

### 语义等级

`auto`：

| 等级 | 候选 |
| --- | --- |
| 1 | exact qualified symbol；LSP/Repo Map 的直接 exact qualified symbol。 |
| 3 | exact symbol/definition；LSP symbol；Repo Map hop 0 exact/short symbol 或 definition。 |
| 4 | symbol prefix 或真实 literal occurrence。 |
| 5 | BM25/path lexical；Repo Map 其他 hop 0 候选。 |
| 6 | Tree-sitter 一跳关系；Repo Map hop 1。 |
| 7 | Repo Map hop 2。 |

`literal` / `regex`：

| 等级 | 候选 |
| --- | --- |
| 0 | 查询在当前 symbol name、qualified name 或 signature 中真实命中。 |
| 1 | 查询在 Tree-sitter code unit 正文中真实命中。 |
| 2 | code unit 外的文本 fallback。 |
| 5 | 仅供有界 hydration 的元数据候选；没有真实命中时不会作为严格主结果。 |

Repo Map 严格候选必须用原 literal/regex 在实时 code unit 中重新验证。`auto` 中只有 hop 0 Repo Map 候选产生 structural 共识证据；传播候选保持 hop 等级。

### Region 合并与最终排序

有 symbol 的 region identity 是 `path + start line + lowercase symbol`；没有 symbol 时使用 code-unit/fallback ID。相同 identity 合并最优等级、证据、理由、命中行和可选关系。

候选依次比较：等级、证据共识、较小 region、路径、起止行。Tree-sitter structural 与 Repo Map structural 属于同一家族，不会因重复确认而增加家族数；LSP semantic 可以与 structural 或 lexical 形成独立共识。

### 打包多样性

`grep_result_limit` 使用两轮确定性选择：

1. 按完整相关性顺序为每个文件选择一个 region；
2. 再按完整顺序填满剩余名额；
3. 所选子集恢复原始相关性顺序后进入 token-budget packer。

测试文件没有全局罚分。`test`、`spec` 等查询词与其他词一样通过本来源的 BM25 和路径 token 影响顺序。

严格查询的非匹配结构候选只能进入独立 `related` 通道。该通道保留 Repo Map 来源顺序，用路径和范围稳定打破平局，并过滤 confidence 低于 `0.5` 或没有可导航关系的候选。

## 执行与复杂度

每个请求为所有通道建立一次 lookup context，复用 file、unit ID、source hash、line index、Repo Map reason 和已验证候选投影。hydration 后只验证新获得正文的候选，再重新计算来源内百分位。

融合器单次扫描所有通道并建立 identity Map。唯一候选沿用原对象；发生 identity 碰撞时才复制并合并，避免修改来源输入。证据状态是固定宽度数值对象，融合与比较均为 `O(1)`。

设融合后候选数为 `N`、结果上限为 `K`。选择器扫描全部候选以保证文件或顶层目录多样性，再用有界最差堆取得精确结果，复杂度为 `O(N log K)`、额外空间为 `O(G + K)`，其中 `G` 是文件或顶层目录数。输出与“完整排序后执行两轮多样性选择”逐项等价。

## 实现与回归边界

主要实现：

- `src/file-tools/ranking-evidence.ts`：百分位、证据合并与共识比较；
- `src/file-tools/ranking-selection.ts`：精确多样性 Top-K；
- `src/file-tools/find/ranker.ts`、`src/file-tools/find/fusion.ts`、`src/file-tools/tools/find.ts`：路径来源与 `find` 融合；
- `src/file-tools/grep/ranker.ts`、`src/file-tools/grep/fusion.ts`、`src/file-tools/tools/grep.ts`：Tree-sitter/text、LSP、Repo Map region 融合；
- `src/file-tools/repo-map-ranking.ts`：直接证据、hop 等级和 related 边界；
- `src/file-tools/find/renderer.ts`、`src/file-tools/grep/packer.ts`：结果与 token 预算打包。

核心不变量由 `tests/file-tools/ranking-evidence.test.ts`、`tests/file-tools/ranking-selection.test.ts`、`tests/file-tools/grep-tree-sitter-fallback.test.ts` 及 `find`、`grep`、LSP、Repo Map 集成测试覆盖。使用 `npm run bench:file-tools:ranking` 测量多通道 identity 重叠下的完整排序与精确 Top-K；可用 `-- --runs=N` 调整采样次数。

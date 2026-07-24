# Repo Map 查询与排序

Repo Map 查询从路径、symbol、架构、测试和 alias seed 开始，通过有限图传播生成候选，再由 File Tools 的实时验证和输出预算决定最终结果。

## Seed

支持的 seed 包括：

- exact path、filename 和 path fragment。
- exact qualified symbol、short symbol 和 signature。
- definition、public export、package、component、entrypoint 和 registration。
- test name。
- term 和 canonical alias。

seed 有数量上限。alias 只代表仓库内已有词汇，不代表模型生成的同义词。

## 图传播

查询使用双向、最多两跳的有限传播，并衰减：

- edge kind。
- resolution。
- confidence。
- 高度节点权重。

边界规则：

- confidence 小于 0.4 的边不传播。
- 低置信度 lexical edge 只能作为末端。
- repository `contains` 不参与传播。
- package/component 不反向展开所有成员。
- 高度节点最多选择 5 个邻居，普通节点最多 12 个。
- 低分或累计 confidence 过低的路径提前停止。

同一候选合并 reasons、alias evidence 和 related edges。最终选择会奖励新的关系角色和不同 component，并惩罚同一路径重复，避免一个 hub 或单一文件占满输出预算。

候选保留 path、content hash、symbol/range、score、confidence、hop、reasons、matched aliases 和 edge evidence。

## `find`

`find` 先检查 exact path，再识别 glob：

- glob query 只做严格路径匹配，不进入 Repo Map 语义召回。
- 其他 query 可以使用 fuzzy path、symbol、alias、package/component、entrypoint、registration、public API 和测试关系。
- 每个候选及 evidence 相关文件都要重新检查 scope、ignore、blocked path、symlink 和实时 content hash。
- Repo Map 不会排除原本能找到的文件，也不会返回虚拟文件。

主结果不足时可以追加少量高置信度结构关联文件，但必须进入独立 `related` 字段，并使用 `<related repo-map nonmatch>` 明确声明它们不保证匹配 query。

## `grep`

`grep` 的 `auto`、`literal` 和 `regex` 都可以请求 Repo Map：

- `auto` 使用 symbol、qualified name、signature、关系、alias、architecture、test 和 registration。
- `regex` 只用最长字面标识片段召回候选；最终仍逐行使用原正则验证。
- `literal` 的主结果必须在当前 code unit 中包含原始大小写敏感文本。
- symbol ID 和 candidate file hash 必须与当前内容一致。

Repo Map、文本/syntax ranker 和可选 LSP 候选先独立生成，再读取实时源码 hydration。通过验证的 region 才能进入主结果；其他结构候选只能进入 `related`。

`related` 与 File Tools 的 `nearby` 不同：

- `nearby` 表达名称、symbol、部分词或路径相似性。
- `related` 表达经实时验证的 Repo Map 图关系。
- 两者都标记为 nonmatch，都不改变 strict glob、literal 或 regex 语义。

没有足够主结果时，最多追加有限 related regions；候选 stale、验证失败、预算不足或 Repo Map 不可用时不返回 related。

## `read`

`read` 只在显式行范围或因预算截断时请求结构上下文。完整读取短文件、图片和不支持的二进制文件不追加 Repo Map context。

增强前比较实时 SHA-256 与 file node content hash，再选择覆盖读取范围且最贴近的 symbol。上下文可以包含：

- symbol kind、qualified name 和范围。
- direct caller、callee、reference 和 import。
- package、component、entrypoint 和 public API。
- 经 hash 验证的 related tests。

Repo Map 不切片正文，也不从 generation 读取历史正文。

## `write` 与 `edit`

只有 mutation 成功写盘后才刷新 Repo Map：

1. 读取 mutation 前 generation。
2. 按 map ID 串行 refresh。
3. 原子提交新 generation 并追加 activation。
4. 对比 before/after generation。
5. 用实时 hash 过滤影响候选。
6. 在有限预算内渲染 impact。

影响候选包括 changed symbol、public API、caller/reference、importer、related test、entrypoint/registration 和少量同 component 候选。impact 是检查建议，不代表编译器或测试结果。

## 稳定性与失败

候选按稳定键排序，路径、范围和关系 evidence 用于打破平局。Repo Map 查询失败时返回 `undefined` 或结构化状态，由 File Tools 退回基础行为；不会把 stale candidate 伪装成实时命中。

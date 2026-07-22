# Repo Map

Repo Map 是面向当前 Git worktree 的本地、持久、可验证代码图。它把文件、符号、包、组件、入口、测试和仓库内词汇组织成一份不可变 generation，并在显式激活后透明增强现有文件工具。

## 性能基准

Repo Map 提供独立于模型和网络的进程冷启动基准：

```bash
npm run bench:repo-map
```

默认使用 100 个 TypeScript 模块，执行 3 次测量和 1 次预热。完整规模矩阵可显式运行：

```bash
npm run bench:repo-map -- --runs=3 --sizes=100,1000,10000
```

基准在临时目录构建确定性 fixture，覆盖扩展加载、inactive 命令、runtime 导入、首次构建、无变化刷新、单文件刷新、generation 冷/热读取、首次/重复查询、read context、mutation 刷新和进程内存。每轮结束都会清理源码与缓存；同一规模的 generation 和查询 oracle 不稳定时基准直接失败。

优化前后必须在同一机器、相同 fixture 和相同运行次数下比较 p50，并满足以下门槛：语义 oracle 与图计数不变；首次构建不回退超过 10%；Pi 启动增量降至 60 ms 内或至少降低 50%；1000/10000 文件的无变化刷新和单文件刷新至少降低 50%；generation 重复读取、重复查询和 read context 至少降低 70%；10000 文件峰值 RSS 至少降低 40%。inactive `status`/`off` 保持不扫描仓库且各自不超过 1 ms。

Repo Map 的目标不是替代编译器、LSP 或文本搜索，而是为它们补充跨文件结构信息：某个符号在哪里定义、谁调用它、文件属于哪个包、入口如何声明、哪些测试与它相关，以及一次修改可能影响哪里。

## 行为保证

- 只有当前 session branch 中成功执行 `/init` 后才激活；磁盘上已有缓存不会自动激活新 session。
- 加载扩展、启动 session 和未激活的文件工具调用不会加载 Repo Map service/parser、探测 Git 或扫描仓库；active `status` 先用独立轻量模块核对安全 `CURRENT` 指针，指针缺失或不匹配时也不加载 service。service 只在首次构建、刷新或完整读取可用 active generation 时加载。
- 不在仓库内写索引，不执行仓库代码，不跟随 symlink，不发送网络请求。
- generation 完整构建、校验并原子提交后才切换 `CURRENT` 和 session activation。
- active runtime 最多保留一个已验证 generation 和对应 QueryIndex；每次命中仍复核 `CURRENT` 及全部快照文件元数据，generation 切换会立即丢弃旧查询索引。
- Repo Map 是附加能力。缓存缺失、候选过期或增强失败时，文件工具退化为原有逻辑。
- 每个候选都携带来源、置信度和源码证据；约定或词法推导不会伪装成精确语义事实。

## 快速使用

```text
/init
/init status
/init refresh
/init rebuild
/init off
```

| 命令 | 行为 |
| --- | --- |
| `/init` | 从当前目录识别 worktree，复用可用 generation，增量构建并激活 Repo Map。 |
| `/init status` | 未激活时只显示 `Repo Map inactive`；激活后先轻量核对 `CURRENT`，匹配时再完整校验缓存与 freshness 并显示统计。 |
| `/init refresh` | 重新读取 HEAD、配置和 ignore，复用未变化的 hash 与解析结果。 |
| `/init rebuild` | 不读取旧 generation 作为增量输入，重新扫描并解析全部有效文件。 |
| `/init off` | 只在当前 branch 追加 deactivation；不删除缓存，不运行 Git 或扫描。 |

模型可见的附加信息由 `agent/configs/repo-map.jsonc` 的 `output` 控制：

```jsonc
{
  "output": {
    "read_context_token_budget": 160,
    "mutation_impact_token_budget": 120
  }
}
```

`read_context_token_budget` 限制 partial/truncated `read` 的 `<repo_map>`；`mutation_impact_token_budget` 限制 `write`/`edit` 的 `<repo_impact>`。两者取值为 0–4096，0 关闭对应附加块。提高预算会按相关性顺序容纳更多关系、测试和受影响文件，但这些内容会留在会话历史并被后续模型调用重复携带。只调整输出预算不会使已有 generation 过期或触发重建；未配置时保持 160/120。

命令不接受路径参数。UI footer 第一行左侧的 git 后常驻显示 `Repo Map: active` 或 `Repo Map: inactive`。初始化命令启动后立即切换为 `Repo Map: preparing`，随后更新为 discovering、scanning、hashing、parsing 和 saving 进度；`/init status` 读取 active generation 时显示 `Repo Map: checking status`。命令结束后恢复当前 activation 状态，进度回调或 UI 不可用不会影响事务。

成功摘要包含文件、解析、符号、测试、边、增删改、复用数量和 freshness。命令状态只显示在 UI，不写入模型上下文。

## Session 激活模型

激活状态保存在不进入模型上下文的 `o-pi:repo-map` session custom entry 中，包含：

- worktree 根目录；
- map ID；
- generation ID；
- 激活时间；
- 可选的 freshness 覆盖和 diagnostic。

当前状态由 branch 上最后一条有效 activation/deactivation 决定。root-specific deactivation 只关闭匹配的 worktree；全局 deactivation 关闭当前 activation；malformed entry 和其他 custom entry 被忽略。

每次工具增强还会检查：

1. session 已激活；
2. activation 的 root、map ID 和 generation 与缓存一致；
3. activation generation 仍是 `CURRENT`；
4. 请求路径位于激活 worktree 内；
5. generation 不是 `stale` 或 `unavailable`。

因此缓存存在、其他 branch 已激活或另一个 worktree 共用同一 Git common directory，都不足以启用当前工具调用。

## 构建流程

一次初始化或刷新按固定顺序完成：

1. 使用 Git 确认当前目录属于非 bare worktree，规范化 worktree root 和 Git common directory，并读取 HEAD；unborn HEAD 合法。
2. 并行读取 Repo Map 配置和该仓库的有效 file-tools 配置。
3. 根据 file-tools 规则生成 ignore snapshot，并计算配置、ignore 和 parser fingerprint。
4. 除 `rebuild` 外读取并完整验证当前 generation，作为增量输入。
5. 扫描文件，复用未变化 hash，读取并 hash 新增或变化文件。
6. 若文件、HEAD 和全部 fingerprint 均未变化，且前后两代都没有 diagnostic，则复用当前 generation，不启动 graph builder 或缓存提交。
7. 解析支持的代码文件，复用 hash 未变化且上次无 parser error 的文件级 symbol/import 结果。
8. 架构和 source alias 复用未变化文件的事实；变化文件及指向它的 re-export 链重新读取。跨文件 symbol 关系复用稳定调用方，并在目标 name lookup 变化时重算受影响调用方。
9. 测试图及最终 edge/alias 集合仍基于当前快照确定性合并；文件增删或无法安全证明依赖稳定时退回完整重算。
10. 再读一次 HEAD；若扫描期间 HEAD 改变，终止且不提交。
11. 将构建结果一次规范化排序并复用于 generation ID、提交校验和序列化；以流式编码计算确定性 ID，并行、分块写入 8 个紧凑快照，校验落盘 checksum 后再切换 `CURRENT`。
12. 命令成功后追加 activation；mutation 刷新成功后切换到新的 activation。

增量复用只接受可由 content hash、稳定 ID 和依赖闭包证明等价的旧事实。任何文件集合变化、旧架构 diagnostic、re-export 依赖变化或全局 symbol lookup 变化都会缩小复用集合或触发完整重算，因此删除文件后不会残留节点、alias 或悬空边。

## 扫描、安全与增量复用

扫描边界来自 Repo Map 与 file-tools 两套配置：文件数量取 `scan.max_files` 和 `grep_max_files_scanned` 的较小值，单文件大小取 `scan.max_file_bytes` 和 `grep_max_file_bytes` 的较小值。

扫描完整复用 file-tools 的：

- `blocked_path` 和 `ignored_path`；
- builtin ignore profile；
- `.piignore` 和可选 `.gitignore`；
- tracked-file bypass；
- 大小写敏感度与路径身份规则。

目录按稳定顺序遍历；`.git`、被 prune 的目录、symlink 目录和 symlink 文件不会进入索引。文件通过 `O_NOFOLLOW` 打开，读取前后比较 size 与 mtime，发生变化时最多重试一次。仍不稳定的文件记录为 `unstable`，不可读取的文件记录为 `unreadable`，超过限制的文件记录为 `too_large`。

文件状态如下：

| 状态 | 含义 | 是否有 content hash | 是否解析 |
| --- | --- | --- | --- |
| `indexed` | 已稳定读取且未超过大小限制 | 是 | 支持语言时解析 |
| `too_large` | 超过有效大小限制 | 否 | 否 |
| `unreadable` | metadata 或内容无法读取 | 否 | 否 |
| `unstable` | 两次读取期间持续变化 | 否 | 否 |

增量扫描以 path、size 和 mtime 判断能否复用旧 content hash；需要读取时使用 SHA-256。并发读取和解析由 `p-limit` 约束，输出最终按稳定键排序，因此并发完成顺序不会改变 generation。

目录不可读、文件不可读、文件不稳定和单文件 parser 失败会形成 diagnostic，并可能让 generation 成为 `partially_stale`；超过总文件数、取消、配置错误、Git 错误、HEAD 变化或缓存提交错误会终止整个事务。

## 代码解析

Repo Map 复用 code-index 的 Tree-sitter runtime：

| 语言 | 扩展名 | 主要符号 |
| --- | --- | --- |
| TypeScript / TSX | `.ts`、`.tsx` | function、method、class、interface、type、enum、declaration |
| JavaScript / JSX | `.js`、`.mjs`、`.cjs`、`.jsx` | function、method、class、declaration |
| Python | `.py` | function、class |
| Go | `.go` | function、method、type、var、const |
| Rust | `.rs` | function、struct、enum、type、trait、impl、const、static、module |

每个 symbol 保存稳定 ID、file ID、kind、name、qualified name、signature、UTF-8 byte range、行范围，以及 definition、reference、call 和 import token。文件在扫描后、解析前会再次校验 content hash，避免把变化中的源码写入 generation。

Tree-sitter 用于建立代码单元和 JavaScript-family syntax facts。文件级 import specifier 由各语言的受限 collector 提取，再进入统一关系解析；这不是编译器级 name resolution。parser 失败只丢弃该文件的 symbol/import 快照，file node 和 diagnostic 仍保留。

## 图数据模型

一个 generation 包含以下节点：

| 节点 | 内容 |
| --- | --- |
| repository | 当前 map 的虚拟根节点。 |
| file | 相对路径、size、mtime、状态和可选 content hash。 |
| symbol | Tree-sitter 代码单元、源码范围、signature、visibility 和词法事实。 |
| package | npm、Python、Go、Cargo 或 repository fallback package。 |
| component | package 下一级目录；直属文件归入 `root` component。 |
| entrypoint | main、module、bin、export、script、test、command、tool 或 plugin。 |
| test | 测试文件或命名测试用例；引用现有 file/symbol，不复制源码。 |

实现的 edge kind：

| 边 | 含义 |
| --- | --- |
| `contains` | repository→file、file→symbol/test、package→component、entrypoint→target file。 |
| `belongs-to` | file/symbol/entrypoint 所属 package 或 component。 |
| `imports` | 文件导入本地文件或 external target。 |
| `exports` | 文件导出顶层 symbol。 |
| `references` / `calls` | symbol 间引用或调用候选。 |
| `declares-entrypoint` / `declares-script` | manifest 声明入口或脚本。 |
| `registers-command` / `registers-tool` / `registers-plugin` | 源码注册 Pi 能力或 plugin。 |
| `exports-publicly` / `re-exports` | 公开 API 和 barrel re-export。 |
| `tests` / `mocks` | 测试目标或 mock 目标。 |
| `uses-fixture` / `uses-snapshot` | 测试资源关系。 |
| `configured-by` | 测试与 runner/manifest 配置关系。 |

每条边都包含：

- `resolution`：`lexical`、`syntactic` 或 `semantic`；
- `source`：Tree-sitter、syntax、manifest、convention 或 LSP；
- `confidence`：0 到 1；
- 可选 `lexicalTarget`；
- 一组 evidence：相对路径、UTF-8 byte/line range 和可选 `textHash`。

当前构建器实际生成 lexical 与 syntactic 关系；`semantic` 和 LSP source 是存储协议预留值，当前不会由 Repo Map 生成。

重复边按 kind、端点、resolution、source、confidence 和 lexical target 合并，evidence 去重并稳定排序。

## 基础关系解析

关系构建首先连接 repository、file 和 symbol，再解析 export、call、reference 和 import：

- 顶层 export 根据语言语法或公开命名约定生成 `exports`。
- call/reference 优先寻找同一 scope、同一文件或全仓唯一 symbol；只有唯一候选才连接具体 symbol。
- 多个候选或不存在候选时保留 `lexical:symbol:*` 目标并降低置信度，不猜测具体定义。
- 相对 import 尝试当前语言扩展名与 `index.*`；本地唯一文件形成 syntactic edge，其余形成 `external:*` edge。
- 保留字、过短 token、自引用和已记录为 call 的重复 reference 会被过滤。

这张图提供可解释的结构候选，但不承诺类型系统、动态 dispatch、条件导入或运行时 module resolution 完整正确。

## 架构图与公开 API

Package 优先来自：

- `package.json` 的 `name`；
- `pyproject.toml` 的 `[project].name`；
- `go.mod` 的 module；
- `Cargo.toml` 的 `[package].name`。

TOML 使用 `smol-toml` 解析。每个嵌套 manifest 都形成独立 package；文件归属 root path 最深的 package。没有 manifest 时，为非空仓库建立低置信度 repository package。

Manifest 入口包括：

- npm `main`、`module`、`bin`、递归展开的 `exports`、`scripts` 和 `test*` scripts；
- Python `[project.scripts]`。

可解析 target 会连接实时 file node；无法解析的命令或 `module:function` target 仍保留 declared target 和较低置信度。

JavaScript/TypeScript 额外从 Tree-sitter AST 提取：

- `registerCommand`；
- `registerTool({ name })`；
- `registerPlugin` / `registerExtension`；
- `export ... from` re-export；
- default export。

静态字符串、无插值 template string 和文件内字符串常量可作为注册名；动态表达式保留文本并降低置信度。注释和字符串中的伪代码不会生成 registration。`agent/extensions`、`extensions` 或 `plugins` 目录中的 default export 会形成低置信度 plugin convention。

公开 symbol 规则：

- JavaScript/TypeScript：顶层 `export`；
- Python：名称不以 `_` 开头；
- Go：名称首字母大写；
- Rust：`pub`；
- manifest public target 和 re-export 会进一步标记 `exports-publicly`。

这些规则产生 `public` / `internal` visibility，供查询和变更影响排序使用。

## 测试图

测试文件识别规则包括：

- `*.test.*`、`*.spec.*`、`test_*`、`*_test`；
- `test`、`tests`、`spec`、`specs`、`__tests__` 目录；
- fixture、mock、snapshot 和 runner 配置本身不会被误当成测试文件。

JavaScript-family 测试从 AST 提取 `describe`、`it`、`test`，包括 `.each(...)` 链上的静态名称；Python、Go、Rust 使用已解析的 `test_*` / `TestXxx` symbol。动态测试名称不生成命名 test node。

关系来源包括：

- 测试 import 和 source/test 同名约定形成 `tests`；
- 测试名称唯一包含某个 symbol 名时形成 symbol-level `tests`；
- `vi.mock`、`jest.mock`、`mock.patch` 和 `patch` 形成 `mocks`；
- import 或静态字符串中的 fixture/testdata 路径形成 `uses-fixture`；
- snapshot matcher 与 `__snapshots__` / `.snap` 文件形成 `uses-snapshot`；
- package.json `test*` scripts、Vitest、Jest、Playwright、Cypress、Karma、pytest/tox 配置形成 `configured-by`。

测试图表示“建议检查的关联”，不代表测试实际运行、覆盖完整或断言正确。

## Lexical alias

`aliases.json` 是完全由当前仓库推导的词汇索引，不调用模型，也不生成开放式同义词。来源包括：

- 文件和目录名；
- symbol name、qualified name 和 signature token；
- import/export alias；
- package、component、entrypoint 和 registration；
- 可识别的 config key、环境变量和 doc comment token。

camelCase、PascalCase、snake_case、kebab-case 和其他非字母数字分隔符会拆成 token 与短语。长度小于 3、纯数字和低信息量词会丢弃；每个 target 最多保留 96 条 alias，并优先保留高置信度来源。

只进行以下固定缩写展开：

| 输入 | canonical |
| --- | --- |
| `repo` | `repository` |
| `cmd` | `command` |
| `cfg` | `config` |
| `ctx` | `context` |
| `deps` | `dependencies` |
| `diag` | `diagnostics` |

每条 alias 保存 term、canonical、target、source、confidence 和 evidence。源码提取前复核 content hash；刷新时整体重算，因此删除或变化目标不会遗留 alias。

## 查询、传播与排序

查询从以下 seed 开始：

- exact path、filename 和 path fragment；
- exact qualified symbol、exact/short symbol 和 signature；
- definition 与 public export；
- package、component、entrypoint、registration；
- test name；
- term/canonical alias。

seed 最多保留 64 个。图遍历为双向、最多两跳，并同时衰减 edge kind、resolution、confidence 和高度节点权重。关键边界：

- confidence 小于 0.4 的边不传播；
- 低置信度 lexical edge 只能作为末端；
- repository `contains` 不参与传播；
- package/component 不反向展开整个成员集合；
- 高度节点最多选择 5 个邻居，普通节点最多 12 个；
- 低分或累积 confidence 过低的路径提前停止。

同一候选会合并 reasons、alias evidence 和 related edges。最终装箱不仅按 score，还奖励新的关系角色和不同 component，并惩罚同一路径重复，避免预算全部被一个 hub 或一个文件占满。

候选保存 path、content hash、可选 symbol/range、score、confidence、hop、reasons、matched aliases 和完整相关 edge evidence。查询索引从不返回缓存中的源码正文。

## 对现有文件工具的增强

| 工具 | Repo Map 行为 | 不变的边界 |
| --- | --- | --- |
| `ls` | 不增强。 | 原目录列表逻辑。 |
| `find` | 非 glob `query` 的名称、路径与语义召回合入结构候选。 | exact path、glob query 严格匹配、scope、ignore、blocked path、symlink 和结果预算。 |
| `grep` | `auto`、`literal` 和 `regex` 均可合入已实时验证的结构候选。 | literal/regex 严格匹配、LSP、scope、glob、源码读取、结果数和 token budget。 |
| `read` | partial/truncated text read 追加紧凑结构上下文。 | 图片、完整短读取、实时正文、行数和字节预算。 |
| `write` | 成功写盘后刷新 Repo Map，并附加影响建议。 | 写入成功不依赖 Repo Map。 |
| `edit` | 成功替换后刷新 Repo Map，并附加影响建议。 | version 校验、替换与 LSP 结果不依赖 Repo Map。 |

### `find`

`find` 先按 `query` 检查 exact path，再自动识别 glob。glob query 只做严格路径匹配，不进入 Repo Map；其他 query 用于 fuzzy 路径排名和 Repo Map 语义召回。候选可能来自 symbol definition、alias、package/component、entrypoint、registration、public API 和测试关系。

查询层先验证每个候选及其 evidence 相关文件的实时 content hash；`find` 再逐项检查搜索 scope、workspace scope、blocked/ignored 规则、真实文件类型和 symlink。按 path 去重、跨来源融合和 result limit 规则见 [文件工具排序算法](file-tools-ranking.md)。glob query 的静态前缀会缩小文件系统遍历范围。

Repo Map 从不排除原本能找到的文件，也不会把 graph node 当成虚拟文件返回。

非 glob 语义查询的主结果少于 4 条时，最多附加 3 条高置信度结构关联文件。关联候选仍需通过 scope、ignore、blocked path、symlink 和实时 hash 校验；它们只进入独立的 `related` 字段。模型输出以 `<related repo-map nonmatch>` 紧凑声明来源和非匹配语义。

### `grep`

`grep` 的 `auto`、`literal` 和 `regex` 都可请求 Repo Map；regex 只提取最长字面标识片段召回候选，没有有效片段时跳过图查询，最终匹配仍使用原表达式。Repo Map 可补充：

- symbol、qualified name、signature 和 definition；
- caller、callee、reference、import/export；
- alias、package、component、entrypoint、registration 和 public API；
- test、mock、fixture、snapshot 和 test config。

Repo Map、原文本/syntax ranker 和可选 LSP 候选先独立生成，再读取实时源码 hydration。Repo Map symbol ID 必须能在当前 grep code unit 中找到，候选文件的 live text hash 必须与 generation 一致；`auto` 还复核相关 edge 文件。`literal` region 必须在该 code unit 的实时源码中包含原始大小写敏感文本，`regex` region 必须逐行通过原正则，并据此生成真实 `match_lines`。通过验证的候选与其他 region 合并、去重、重排，最后交给原 packer 执行 result limit、token budget 和多样性选择。

Repo Map、Tree-sitter/text 和可选 LSP 的无训练融合、证据家族与 hop 排名规则统一记录在 [文件工具排序算法](file-tools-ranking.md)。

严格模式只预读有界数量的直接候选文件，不为关系边额外 hydration 源码；查询 limit、源码读取并发和 hash 缓存沿用 file-tools 预算。没有满足严格条件的图候选时，主结果与未启用 Repo Map 相同，候选只能按以下规则进入独立关联通道。

`literal`/`regex` 主结果少于 4 个 region 时，可在同一 token budget 内附加最多 3 个 `related` region。结构关联候选必须位于搜索 scope、通过实时 hash 与 symbol ID 校验，并且经过原 literal/regex 后确认不能进入主结果；grep glob 之外的候选同样只能进入此通道。严格索引仅额外保留轻量 scope 路径，之后只对 Repo Map 预选文件执行有界 stat、源码读取和按需解析。

`find` 和 `grep` 共用 `RepoMapRelatedResult`：`source="repo-map"`、`relations` 和 `query_match="not_guaranteed"` 是必需字段。关联结果保留 Repo Map 已生成的来源顺序，以路径和范围稳定打破平局，并过滤 confidence 低于 0.5 或没有可导航关系的候选；文件工具不再维护另一套手写关系权重。模型文本与展开 UI 均显示来源、关系和非匹配声明；主结果充足、预算不足、候选 stale 或 Repo Map 不可用时不返回 `related`。

`related` 与文件工具自己的 `nearby` 是不同通道：`nearby` 只在主结果为空时表达名称、symbol、部分词或路径相似性，`related` 表达经实时验证的 Repo Map 图关系。两者都明确标记为 nonmatch，都受同一模型 token budget 约束，均不得进入主结果或改变严格 glob/literal/regex 语义。

因此模型看到的始终是当前文件系统中的代码片段，而不是缓存中的历史正文。每个 Repo Map region 只保留一个最高价值的命中原因和可选 hop；alias 只在 term 与 canonical 不同时显示映射，不输出内部 source。calls/imports 仅在对应关系促成命中且 packer 只能保留 signature 时输出，完整 body 或 snippet 不重复摘要源码中已经可见的关系。

结构化 `strategy` 只有最终打包结果实际保留 Repo Map region 时才包含 `repo-map`，此时模型头从 `<grep>` 变为 `<grep repo-map>`；query、path、match 和计数已存在于 tool call/details，不在模型结果中重复。模型文本省略默认 `hop 1`，严格模式再省略可由调用参数推导的 `exact literal`/`regex`；结构化 details 仍完整保留。未激活、越界、stale、验证失败或查询异常时，候选为 `undefined`，后续 ranking、packing 和模型文本与没有配置 Repo Map 时完全一致。

### `read`

`read` 只在显式行范围或因预算截断时请求 Repo Map。完整读取短文件、图片和不支持的二进制文件不会追加结构上下文。

增强前先比较 read 得到的实时 SHA-256 与 file node 的 content hash，再选择覆盖读取范围且最贴近的 symbol。可返回：

- symbol kind、qualified name 和范围；
- 最多两条 direct caller、callee、reference 和 import；
- package、component、entrypoint 和 public API；
- 最多两条经 hash 验证的 related tests；

模型可见格式是三行 `<repo_map>...内容...</repo_map>`，内容行压缩 symbol、直接关系、架构信息和 related tests。formatter 使用项目已有 `gpt-tokenizer` 把完整标签限制在 160 token，并对各字段执行数量和字符上限。`read` 按最终标签加换行的真实 UTF-8 字节数和三行结构从现有 byte/line budget 扣除，不再按内部对象估算；若标签本身超过 byte budget，则直接省略。Repo Map symbol 与 LSP enclosing symbol 指向同一范围时只保留 Repo Map 表达。

未启用或增强失败时不重新切片正文，也不增加占位 tag、状态字段或预算预留，结果与普通 `read` 字节一致。文件正文仍来自实时读取，Repo Map 不改变版本记录和 LSP read enhancement。

示例：

```xml
<repo_map>
symbol="function Auth.login 12-28" public_api="true" package="core" component="src" tests="tests/auth.test.ts" callers="src/app.ts:start"
</repo_map>
```

### `write` 与 `edit`

只有文件工具已经成功写盘后才同步 Repo Map。当前 session 未激活或 mutation 位于 worktree 外时直接跳过。激活时：

1. 读取 mutation 前 generation；
2. 对同一 map ID 在进程内串行执行 `refresh`，避免旧工作区快照覆盖新提交；
3. 扫描最终工作区状态，原子提交 generation 并追加新 activation；
4. 对比 before/after generation，计算影响候选；
5. 再用实时 hash 过滤影响文件；
6. 把完整结果写入 tool details，并以不超过 120 token 的 `<repo_impact>...</repo_impact>` 压缩给模型。

影响分析识别：

- 新增、删除、签名变化或范围包含 changed line 的 symbol；
- public API signature/visibility 变化；
- direct caller、reference 和 importer；
- 显式 related test，以及受影响 dependent 的二跳 test；
- entrypoint/registration；
- 最多两个低优先级 same-component 候选。

默认 mutation 输出最多 8 个候选；内部 API 支持 1–24。排序优先级依次偏向 changed/public API、caller/reference、public dependent/importer、test、entrypoint，component 仅作补充。每项保存 role、reason、distance、confidence 和 evidence。

示例：

```xml
<repo_impact>
symbols="api changed function login" affected="src/app.ts:caller" tests="tests/auth.test.ts"
</repo_impact>
```

tag 的存在已经表示 impact candidate，因此不输出恒真的 `candidate`；changed path 已在外层 `write`/`edit` 中，不再重复。public API 状态直接标在 symbol change 上，同一路径不会同时进入 `affected` 和 `tests`。没有 symbol、affected 或 test 信息时省略整个 tag。

影响结果只是检查建议，不自动运行测试，也不证明影响完整。如果刷新或影响分析失败，`write`/`edit` 的成功结果不变：刷新失败会返回 `repo_map="partially_stale"` 和 diagnostic，并在 session 中追加 partially-stale activation；单独的影响分析失败只省略 impact。

## Freshness 与实时验证

| 状态 | 产生条件 | 文件工具行为 |
| --- | --- | --- |
| `fresh` | generation 与 HEAD、配置、ignore、parser 及构建结果一致。 | 正常使用。 |
| `partially_stale` | 存在局部 unreadable/unstable/parser/架构/测试 diagnostic，候选 hash 不一致，或 mutation 刷新失败。 | gate 仍允许，但只使用实时 hash 验证通过的节点。 |
| `stale` | HEAD、Repo Map/file-tools 配置、ignore fingerprint 或 parser fingerprint 整体变化；轻量状态检查失败也按 stale 处理。 | 停用增强。 |
| `unavailable` | activation generation、`CURRENT` 或缓存快照缺失、损坏、不匹配。 | 停用增强。 |

`status` 和每次文件工具查询都会确认 activation 指向当前 generation。具体候选使用前还会复核候选文件、edge related files 和带 `textHash` 的 alias evidence。发现局部 hash 不一致时丢弃相关候选，并追加 partially-stale activation；不会把旧 range 或旧正文交给模型。

## 持久化与事务

默认缓存位于 `~/.pi/cache/repo-map`，可用 `PI_REPO_MAP_CACHE_DIR` 覆盖：

```text
<cache-root>/
  <map-id>/
    CURRENT
    COMMIT_LOCK/
    generations/
      <generation-id>/
        metadata.json
        files.json
        symbols.json
        tests.json
        architecture.json
        aliases.json
        edges.json
        diagnostics.json
```

当前 schema version 为 5。map ID 由 schema major、规范化 worktree root 和 Git common directory 共同计算；不同 worktree 即使共用 common directory，也有不同 map ID。

generation ID 是以下稳定快照的 SHA-256：

- map ID、schema version；
- Repo Map 与完整 file-tools 配置 fingerprint；
- ignore 和 parser fingerprint；
- 可选 HEAD revision；
- 排序后的 file、symbol、test、architecture、alias、edge 和 diagnostic。

时间戳、PID 和随机值不参与 generation ID；相同输入得到相同 generation。无变化时复用已有 generation 目录，只更新 `CURRENT`。

提交使用 `proper-lockfile` 对每个 map 获取跨进程原子目录锁，锁租期 10 分钟且不排队重试。新 generation 先写入私有临时目录，8 个紧凑 JSON 文件以 exclusive create、固定大小缓冲并行写入并分别 `fsync`，不会同时保留 8 份完整序列化字符串；目录整体 rename 后以 `O_NOFOLLOW` 并行流式回读，校验长度和 SHA-256 与已完成内存语义校验的写入内容一致。`CURRENT` 也通过临时文件 rename 原子替换。失败、取消或竞争不会让半成品成为 current。

缓存目录尽量设置为 `0700`，文件为 `0600`；map/generations/generation 必须是真实目录而非 symlink。提交成功后按 `cache.max_generations` 保留 current 和最近 generation；清理失败不会回滚刚提交的 generation。

读取缓存时先使用预编译 TypeBox schema 校验 shape 和 `additionalProperties: false`，再校验：

- canonical absolute root 和安全相对路径；
- map/file/symbol 稳定 ID；
- source range 和计数；
- 节点 owner、alias target 和 edge endpoint；
- 严格稳定排序；
- metadata 计数与实际数组；
- generation hash。

任一检查失败都把 generation 当作不可用，而不是部分信任损坏数据。

## 配置

用户配置路径为 `~/.pi/agent/configs/repo-map.jsonc`，可用 `PI_REPO_MAP_CONFIG` 覆盖：

```jsonc
{
  "$schema": "../schemas/repo-map.schema.json",
  "scan": {
    "max_files": 100000,
    "max_file_bytes": 1048576,
    "concurrency": 8
  },
  "cache": {
    "max_generations": 2
  }
}
```

| 字段 | 默认值 | schema 范围 | 含义 |
| --- | ---: | ---: | --- |
| `scan.max_files` | 100000 | 1–1000000 | 扫描允许的最大文件数；还受 file-tools 更严格限制。 |
| `scan.max_file_bytes` | 1048576 | 1–104857600 | 单文件最大字节数；还受 file-tools 更严格限制。 |
| `scan.concurrency` | 8 | 1–32 | hash、解析和源码 alias 提取并发上限。 |
| `cache.max_generations` | 2 | 1–10 | 每个 map 保留的 generation 数量。 |

未知字段、错误类型和越界数值都会报 `CONFIG_ERROR`，不会静默忽略。

## 错误与恢复

会终止初始化的结构化错误包括：

- `NOT_GIT_WORKTREE`：当前目录不在非 bare Git worktree；
- `GIT_UNAVAILABLE`：Git 不可用；
- `CONFIG_ERROR`：Repo Map 或 file-tools 配置无效；
- `SCAN_LIMIT_EXCEEDED`：有效候选超过文件上限；
- `OPERATION_ABORTED`：用户取消；
- `CACHE_ERROR`：缓存目录、锁、校验或提交失败；
- `REPOSITORY_CHANGED_DURING_SCAN`：构建期间 HEAD 改变。

恢复方式通常是修复原因后执行 `/init refresh`；怀疑旧快照或 parser 复用时执行 `/init rebuild`。缓存损坏不需要手工删除：新的有效 generation 会重新生成，冲突的损坏 generation 会移到 `.corrupt-*` 后再提交。

## 明确不做的事

当前 Repo Map 不包含：

- watcher 或后台持续索引；
- embedding、向量数据库、LLM query expansion 或网络服务；
- 编译器级类型解析、动态调用图或完整 module resolution；
- LSP semantic edge 写入 Repo Map；
- Git history、rename、co-change 或 churn 分析；
- 自动运行测试、自动修改文件或阻止成功 mutation；
- 对 `ls`、命中 exact path 的 `find` 和完整短 `read` 的增强。

这些边界保证 Repo Map 保持本地、确定、可解释，并且在任何失败情况下都能安全退化。

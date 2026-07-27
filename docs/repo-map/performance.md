# Repo Map 性能与缓存

## 主要成本

Repo Map 的成本主要来自：

1. repository discovery 和文件扫描。
2. 文件身份和内容变化检测。
3. symbol、architecture、relationship 和 test indexer。
4. generation 序列化和提交。
5. 查询和 mutation impact 的候选收集、实时校验与上下文渲染。

## 单次解析与坐标索引

首次解析一个支持的源码文件时，`ParsedDocument` 在同一调用链内共享 Tree、原文和 `SourceIndex`：code units/imports 与 JavaScript syntax facts 不重复创建 AST。transient facts 不写入 generation，native Tree 不跨 refresh 或 worker 保存。

`SourceIndex` 保存行起点和 UTF-8 byte 长度。ASCII 文件 char→byte 是 O(1) 且不分配整文件映射；非 ASCII 文件只扫描一次建立 `Uint32Array`。unit 内容直接按 char range slice，byte range 统一转换，热循环中不再对每个 unit 执行 `Buffer.from(text)` 或从行首重复编码。

Parser 按 grammar descriptor 缓存于当前进程或 worker，并在解析不同文档前 reset；grammar/runtime、timeout 和 parser exception 返回结构化 failure。parser 缓存不跨 worker 共享 native 对象。

## 首次构建与增量刷新

首次构建扫描并建立完整图。refresh 可以复用 previous file records、未变化文件的 symbol/import/architecture 数据；变化文件重新校验 content hash 并解析。正常 service 链中，symbol parser 产生的 syntax facts transient 传给 architecture/test，不再重复读取或解析同一变更 JS-family 文件。

文件、Git revision、配置和 ignore 均未变化时，`fresh` generation 可以直接复用。`partially_stale` generation 也可以复用，但其全部 diagnostics 必须是绑定到前后相同 indexed content hash 的 `PARSER_SYNTAX_ERROR`；其他 parser、read、scan、architecture 或 test diagnostics 仍会触发重试。局部刷新时，满足同一条件的 syntax diagnostic 会随未变化文件保留，而不是重新解析或静默丢弃。

Test graph 接收 previous files、symbols、tests、相关 edges 和 diagnostics。文件身份集合、test/config/resource 内容、test import 关系以及 symbol name/file identity 都相同时，直接复用 previous test nodes 和 test-owned edges；普通 production body mutation 因此不再读取或解析未变化 test files。任一输入无法证明等价时会保守重建。重建路径预先建立 import、symbol name、source stem、resource/snapshot 和 runner configuration lookup，避免在每个 test case 上重复扫描整图。

Lexical alias indexer 按 target 比较 file、symbol、architecture 和 lexical edge 的完整输出输入；fingerprint 相同时直接合并 previous target fragment，变化 target 才重新分词、提取 source aliases、去重和排序。构建内的 term/canonical memo 与 generation canonical encoder 都有单次调用生命周期；encoder 只为不超过 20,000 个 value、8 MiB 的数组复用序列化结果，超过预算立即使用流式双遍编码，避免形成历史缓存或随仓库无界增长。

## 并发与 worker

`scan.concurrency` 控制扫描、局部索引和 Repo Map parser worker 数量。Repo Map parser 先按待解析 file count、total bytes 和 max file bytes 估算成本：小 workload 保持 main-thread local path，大 workload 使用有界 worker pool。每个 request 最多包含固定 batch（当前为 16 个文件），worker 数不超过 `scan.concurrency`，从而限制消息和解析结果的同时驻留量。

worker 内完成 no-follow source 读取、content hash 二次校验、code index 和 syntax facts 提取，只返回可序列化结果。结果按输入文件顺序重新组装，再按稳定比较器排序；worker 完成顺序不会改变 generation digest。worker 创建或执行失败时，正常解析路径使用同一份本地逻辑重试；AbortSignal 取消会终止正在执行的 worker，绝不改为成功 fallback。

grep 和 Repo Map 共用严格类型的 worker task lifecycle：queue、request ID、abort、worker crash、ref/unref 和 dispose。小 workload、注入 `analyze`/`readText` 的测试路径以及 worker failure 都保留原有 local/offload 语义。

同一个 map 的 refresh 使用串行更新锁；不同 map 可以独立执行。并发提高吞吐，但会增加磁盘竞争和 RSS 使用。

## Mutation generation handoff 与 impact

`write`/`edit` 成功提交文件后仍同步等待 Repo Map refresh 和 impact，工具返回前新 generation 已原子提交。mutation 链路首次读取并验证 activation 指向的 before generation，随后把该不可变对象传给 refresh。service 只有在 root、map ID、activation generation 均匹配且磁盘 `CURRENT` 仍指向它时才使用；否则回到正常 generation reader。refresh 直接返回复用或刚提交的 generation，impact 无需再从磁盘读取 after generation。

Impact 为 before/after generation 各建立一次局部只读 lookup，并在一次 edge traversal 中收集 seed 邻接、test、component 和 entrypoint 关系。changed symbols 按 file ID 查找，后续候选规则使用分组结果，不再为每种关系重复线性扫描全部 edges。候选 key、优先级、排序、evidence、预算和最终实时 content hash gate 不变；lookup 只存活于单次分析，不形成历史 generation cache。

## Cache

每个 map 保留有限数量 generation。新 generation 成功提交后，旧 generation 按稳定规则清理；current pointer 始终指向完整提交的 generation。

缓存读取使用有限的进程内 reader cache，但 freshness 仍会检查磁盘 current pointer、Git revision、配置和 ignore fingerprint。worker 生命周期结束后会 terminate/dispose，idle worker 使用 `unref`，不阻止进程自然退出。

## 调优方向

优先调整：

- `scan.max_files`
- `scan.max_file_bytes`
- `scan.concurrency`
- `cache.max_generations`
- 输出 token budgets

不要通过提高 limits 来掩盖 ignore 配置过宽、生成了不必要的大量候选或 parser diagnostics。小仓库不应为了并行启动 worker。

## Benchmark

Code-index 基准不依赖模型或网络，覆盖 ASCII、Unicode、dense declarations、长单行、import-heavy、cold/warm parser、local/worker batch 和 RSS：

```bash
npm run bench:code-index
```

Repo Map 基准使用临时目录中的确定性 fixture。module fixture 覆盖扩展加载、inactive command、runtime import、首次构建、无变化/单文件刷新、generation 冷/热读取、首次/重复查询、read context、mutation refresh、impact、generation/oracle digest 和 RSS。固定的 100-pair test-dense fixture 另覆盖稳定 syntax diagnostic、unchanged partial refresh、production source mutation、test source mutation，以及 generation read、test graph、commit、refresh、impact 和端到端 mutation 阶段：

```bash
npm run bench:repo-map
npm run bench:repo-map -- --runs=3 --sizes=100,1000,10000
```

统一 benchmark 会注册 code-index 与 Repo Map suite：

```bash
npm run bench
npm run bench -- --quick --suites=code-index,repo-map
```

基准比较必须使用相同机器、fixture 和运行次数，并同时确认：

- semantic oracle、图计数和 generation digest 不变。
- inactive `status`/`off` 不扫描仓库。
- 首次构建、无变化 refresh 和单文件 refresh 没有明显回退。
- test-dense production/test mutation 的图计数和 oracle 不变，production mutation 命中 test graph reuse，test mutation仍正确重建。
- unchanged partial refresh 不运行 test graph 或 commit；mutation generation read 只做 supplied previous 的 `CURRENT` 检查。
- warm parser 优于 cold parser；dense 4k/8k/16k 不出现 unitCount×fileSize 编码增长。
- worker/local batch 与 parser 结果相同，峰值 RSS 保持可接受范围。
- generation 重复读取、重复查询和 read context 的优化不改变结果。

每轮结束会清理源码和缓存；同一规模的 generation 或 query oracle 不稳定时基准直接失败。其他工具的统一指标见 [benchmark.md](../benchmark.md)。

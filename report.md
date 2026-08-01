# `src` 代码简化与性能审查报告

## 1. 范围与结论

- 审查范围：`src/` 下 342 个 TypeScript 文件，约 50,838 行源码。
- 审查目标：减少不必要的代码、分配、复制和重复实现，同时保持现有公开行为。
- 基线状态：工作区在审查开始时干净；`npm run typecheck` 通过；`npm test` 通过 1,396 个用例，跳过 2 个用例。
- 本报告只记录问题和建议，没有修改实现代码。

结论：当前最大的收益不来自压缩语法，而来自把整文件物化、重复全量扫描和 O(n²) 路径改为单次线性处理。这些修改通常还能删除中间数组和辅助函数。其次是合并多套同构配置、超时、匹配和 Pi 适配代码。Telemetry、TUI 与 prune 中也存在可优化路径，但语义和状态风险更高，应后置。

优先级定义：

- P0：正确性问题，或已确认会在合理输入上出现病态时间、内存开销。
- P1：收益明确、风险可控，适合在对应模块改动时实施。
- P2：冷路径、离线任务或依赖更多语义验证的候选优化。
- D：以减少重复实现和代码行为面为主的去重项。

文中的耗时和内存数字来自同机一次性微基准，仅用于确认复杂度趋势，不作为稳定性能契约。

## 2. P0：优先处理

### F-01 超长单行文件扫描存在 O(n²) 累计复制

- 位置：`src/filesystem/services/content.ts:195-247`，主要是第 220 行附近。
- 现状：每读入一个 64 KiB chunk 都执行 `pending = concatBytes(pending, chunk)`。文件长期没有换行时，每次都复制此前累计的全部字节。
- 影响：长单行、压缩后文本或生成文件会快速退化。通过真实 `GrepTool` 路径测试，1/2/4/8/16 MiB 单行文件约耗时 119/121/391/1,319/4,440 ms，趋势接近 O(n²)。
- 建议：保留分段 chunk，只在形成完整行时合并一次；或者直接在 chunk 上扫描分隔符，仅保留跨 chunk 的尾段。
- 可简化内容：删除每轮累计拼接逻辑，让缓冲区职责收敛为“未完成行的分段集合”。
- 风险：中。必须保持 CRLF、裸 CR、跨 chunk UTF-8、多字节字符、BOM、byte offset、取消和 stable snapshot 语义。
- 验证：扩展 `tests/filesystem/content.test.ts`、`tests/file-tools/grep-integration.test.ts`，增加多尺寸无换行文件的回归和 benchmark。

### F-02 `sliceTextByLineRange` 为局部读取物化整文件行数组

- 位置：`src/filesystem/services/text.ts:138-184`、`src/filesystem/services/text.ts:250-265`。
- 现状：`lineRecords()` 先为整份文本创建每行记录；即使只读取前 10 行，也会扫描并保存全部行。
- 影响：16 MiB、约 838 万短行的文本只取前 10 行，实测约 481-501 ms，临时 heap 增长约 268-284 MiB。
- 建议：把 `lineRecords` 改为 generator 或游标。跳到 `startLine` 后边选择边累计 byte，达到 `endLine`、行数或 byte 限制后立即停止。
- 可简化内容：删除完整 `LineRecord[]` 构造和第二阶段遍历。
- 风险：低。重点保持 CRLF、裸 CR、原始 terminator、单行超限和 continuation 标记。
- 验证：`tests/filesystem/text.test.ts`、`tests/file-tools/read.test.ts`、`tests/filesystem/content.test.ts`。

### F-03 `describeText` 为元数据统计分配标准化全文和行数组

- 位置：`src/filesystem/services/text.ts:33-38`。
- 现状：为计算 `totalLines` 调用 `logicalLines()`，先标准化并切分全文；随后 `detectNewline()` 再扫描一次。
- 影响：16 MiB 短行文本实测约 175-191 ms，临时 heap 增长约 64 MiB。
- 建议：使用一次状态扫描同时统计逻辑行数以及 LF、CRLF、裸 CR 类型，不创建行数组。
- 风险：低。
- 验证：覆盖空文本、仅换行、尾部换行、mixed newline；使用 `tests/filesystem/text.test.ts` 和 `tests/filesystem/content.test.ts`。

### F-04 Bash 输出捕获在大块输出上进行昂贵字符级处理

- 位置：`src/bash-tool/output-capture.ts:18`、`src/bash-tool/output-capture.ts:47-100`、`src/bash-tool/output-capture.ts:121-135`。
- 现状：每个 chunk 都重复计算 UTF-8 长度；`takeTailBytes` 使用 `Array.from` 并逐字符向前拼接；尾部字符串也会反复合并。
- 影响：默认失败预览约 192 KiB。以 64 KiB chunk 输入、禁用完整 capture 的微基准中，1/4/16/64 MiB 约耗时 80/253/972/4,055 ms。
- 建议：使用有界 Buffer 保存 head/tail，按 byte 统计 LF/NUL，只在 `liveText` 或 `finish` 时解码；边界辅助函数直接在 Buffer 上确定合法 UTF-8 截断点。
- 可简化内容：删除字符数组转换、逐字符 prepend 和多套 byte-length 调整逻辑。
- 风险：中。必须保留跨 chunk `StringDecoder` 语义、astral 字符、精确 byte budget、行数统计以及 head/tail 不重复。
- 验证：保留 `tests/bash-tool/execution.test.ts:450-459` 的跨 chunk UTF-8 用例，并增加 byte 边界、astral 字符、超大单 chunk 和连续 chunk 的性能回归。

### F-05 Bash 操作异常时可能不关闭 capture 资源

- 位置：`src/bash-tool/bash-tool.ts:119-131`。
- 现状：非 abort 的 operation error 会在 `capture.finish()` 前重新抛出，可能遗留 `WriteStream` 或临时日志。
- 影响：异常路径可能泄漏文件描述符和临时文件；高频失败时会积累资源。
- 建议：让 capture 进入统一 `finally` 关闭路径；关闭失败不能覆盖原始 operation error。
- 风险：低至中，需要明确原始错误优先级和 abort 行为。
- 验证：增加“先写输出再抛错”用例，断言流关闭、临时资源清理、原始错误不被替换。

### F-06 编辑成功路径按 replacement 次数重复扫描完整结果

- 位置：`src/file-tools/edit/command.ts:274-288`、`src/file-tools/edit/command.ts:371-384`。
- 现状：先生成 output spans，再为每个 span 调用 `lineRangeAt`/`lineAtOffset`；每次都从更新后文本开头重新数行。
- 影响：`replace_all` 命中数没有上限，复杂度为 O(k*n)，默认文件上限可到 16 MiB。
- 建议：在已有的有序 replacement 拼接循环中维护当前输出行号，一次扫描 unchanged/new chunk 并直接产生 changed ranges。
- 可简化内容：删除 `outputSpans`、`lineRangeAt`、`lineAtOffset`，保留 chunks + join。
- 风险：低至中。要保持当前只按 LF 增行、空 replacement、相邻范围合并等语义。
- 验证：扩展 `tests/file-tools/edit.test.ts`、`tests/file-tools/lsp-hooks.test.ts`，覆盖大量 `replace_all`、多行 replacement、删除和相邻修改。

### F-07 Visibility 路径规则在每次 evaluate 时重新编译

- 位置：`src/filesystem/services/visibility/snapshot.ts:168-176`、`src/filesystem/kernel/access-policy.ts:59-93`。
- 现状：每个 entry、每条 configured rule 都重新执行 tilde 展开、路径规范化、规则编译，并创建候选数组和 `Set`。
- 影响：100k 次 evaluate 时，0/1/10/50 条规则分别约耗时 32/276/1,924/8,828 ms。
- 建议：抽取共享的 compiled path-rule matcher；由 `WorkspaceAccessPolicy` 和 `CompiledVisibilitySnapshot` 在构造时各编译一次，并复用现有 identity matcher。
- 风险：低。`~` 会在不可变 snapshot 构造时固定解析，符合当前 policy 语义。
- 验证：`tests/filesystem/visibility.test.ts`、`tests/filesystem/namespace.test.ts`；增加绝对、相对、目录和 tilde 等价表驱动用例。

### F-08 Approval 持久规则并发初始化存在竞态

- 位置：`src/approval/gate.ts:49-83`。
- 现状：闭包中的 store 和路径在 `await loadPersistentRules` 前被替换；同一时刻的第二个调用可能读取尚未完成初始化的新 store。
- 影响：并发审批可能绕过已持久化规则，或观察到不完整状态。
- 建议：缓存 `{ path, ready: Promise<ApprovalStore> }`；所有调用等待同一个 promise，失败时原子清空以允许重试。
- 可简化内容：用单一初始化状态替代“已赋值但未 ready”的隐式状态组合。
- 风险：中，属于并发状态修复。
- 验证：增加同 tick 并发、只加载一次、路径切换、加载失败后重试用例。

### F-09 LSP reload 与新操作登记之间存在 TOCTOU

- 位置：`src/lsp/manager.ts:99-143`、`src/lsp/manager.ts:756-779`。
- 现状：`withClientOperation` 先等待 reload，再增加 active counter。reload 可能在二者之间开始，并看到 active 为 0。
- 影响：操作可能与 client reload/dispose 重叠，产生关闭中的 client 被使用、请求丢失或状态不一致。
- 建议：使用原子的 admission loop/latch，在确认无 reload 和登记 active 之间不留 await 窗口。
- 可简化内容：正确的 admission 状态机有机会删除 busy-yield 和 `reloadRequested` 的部分补偿逻辑。
- 风险：中至高，需要保护取消、失败和连续 reload。
- 验证：增加 operation 与 reload 同 tick、连续 reload、operation 失败和取消场景。

## 3. P1：收益明确的后续优化

### F-10 Incremental visibility 重复构造 tracked 派生状态和 evaluator

- 位置：`src/filesystem/services/visibility/incremental-operations.ts:197-233`、`src/filesystem/services/visibility/incremental-operations.ts:296-317`、`src/filesystem/services/visibility/rule-compiler.ts:128-137`、`src/filesystem/services/visibility/snapshot.ts:45-50`。
- 现状：每加载一个 nested ignore 文件就重排全部规则、重新排序/拼接 tracked set，并生成小写 tracked `Set`。
- 影响：模拟 100k tracked paths、20 次 fingerprint + snapshot 重建约 430 ms，尚未包含规则编译。
- 建议：构造期预计算 tracked lookup/fingerprint；规则变化只标 dirty，在首次 `evaluate` 或读取 snapshot 时惰性重建，从而合并同一并发 batch。
- 风险：中。必须验证 sibling 规则并发加载、最终 fingerprint 和 evaluator 可见性。
- 验证：`tests/filesystem/visibility.test.ts`、`tests/filesystem/visibility-cache.test.ts`、`tests/filesystem/readonly-services.test.ts`。

### F-11 Read 在没有可保留 structure 时重复执行同一 slice

- 位置：`src/file-tools/read/command.ts:124-136`、`src/file-tools/read/command.ts:170-197`。
- 现状：partial/truncated read 已执行一次 slice；structure port 缺失、失败或内容放不下时，`reserveContextBudget` 仍按相同预算再次 slice。
- 影响：重复全文或深 offset 扫描，放大 F-02 的成本。
- 建议：`selectedStructure === undefined` 时直接返回 `initialSlice`，只有真正预留 structure budget 时才重切。
- 风险：很低。
- 验证：`tests/file-tools/read.test.ts` 的 partial、truncated、structure budget 场景。

### F-12 Visibility BFS 队列通过头部 `splice` 反复搬移元素

- 位置：`src/filesystem/services/visibility/rule-discovery.ts:61-75`、`src/filesystem/services/visibility/incremental-operations.ts:256-293`。
- 现状：循环执行 `pending.splice(0, batchSize)`。
- 影响：大型目录树最坏可退化为 O(D²) 数组搬移。
- 建议：使用 append-only 数组和 `head` 游标，通过 `slice(head, head + batchSize)` 取当前批次。
- 风险：很低，且通常能缩短循环代码。
- 验证：补宽目录树扫描，确认 BFS 批次顺序和并发上限不变。

### F-13 Bash virtualenv 探测串行等待多个目录

- 位置：`src/bash-tool/bash-tool.ts:176` 附近。
- 现状：最多约 8 个候选目录逐个 await 文件系统探测。
- 影响：慢文件系统、网络挂载或冷缓存下延迟按候选数累加。
- 建议：并行执行候选探测，再按原有优先级选择第一个成功项。
- 风险：低。必须维持原始优先顺序，而不是按完成顺序选择。
- 验证：使用可控延迟 fake filesystem 验证并发和确定性优先级。

### F-14 Subagent 每次进度更新复制全部历史事件

- 位置：`src/subagent/process.ts:108-152`。
- 现状：每条消息或 tool result 都执行 `events.map`，并再次发送完整 output、stderr 和事件历史。
- 影响：N 个事件产生 O(N²) 累计复制；当前 TUI 实际只展示末尾有限事件。
- 建议：使用 dirty + throttle 合并更新；中间进度只携带有界 tail 和总数，最终结果再保留完整历史。如果公开回调契约要求完整快照，则至少节流并复用不可变快照。
- 风险：中，进度 payload 可能属于内部契约。
- 验证：覆盖大量事件、最终历史完整性、取消和最后一次 update 不丢失。

### F-15 Bash list separator 查找对长命令链重复扫描 children

- 位置：`src/approval/bash-parser.ts:203-237`。
- 现状：每个 named child 都在 `separatorAfter` 中对 `parent.children` 执行两次 `findIndex`，随后扫描中间节点。
- 影响：长 `a && b && ...` 链接近 O(n²)。
- 建议：在 `analyzeList` 中维护 raw-child 游标，单次前向扫描生成当前 named child 后的 separator。
- 可简化内容：可以删除独立的 `separatorAfter` 及其多次查找。
- 风险：低至中。需保持 `&&`、`||`、`;`、`&`、嵌套 list 和注释节点的语义。
- 验证：增加长链、混合 separator、嵌套 list 测试。

### F-16 LSP symbol 选择先 flatten/filter/sort 全量数据

- 位置：`src/lsp/symbols.ts:67-90`、`src/lsp/symbols.ts:137-158`、`src/lsp/code-analysis.ts:91-105`。
- 现状：查找 enclosing/modified symbol 时先 flatten 所有 symbol，再 filter 和 sort；多个 changed range 会重复排序。另一个模块维护了第二套递归 flatten。
- 影响：大 symbol tree 或多 changed ranges 下产生多份数组和 O(R*S log S) 排序。
- 建议：共享迭代 DFS/generator；enclosing symbol 使用单次 best-so-far，modified ranges 至少避免每个 range 全排序。
- 可简化内容：合并两套 symbol tree 遍历，删除临时 candidates 排序。
- 风险：中。要保持最小 enclosing range、qualified name 和稳定 tie-break。
- 验证：深层 symbol tree、重叠 symbol、多个 changed ranges、DocumentSymbol 与 SymbolInformation 混合输入。

### F-17 HTTP 正文读取重复，models endpoint 还没有大小上限

- 位置：`src/web-tools/network/response-body.ts`、`src/usage/client.ts:457-506`、`src/openai-compatible-provider/models-endpoint.ts:65-95`。
- 现状：web 与 usage 各自实现受限 stream 读取；models endpoint 直接调用无上限的 `response.text()`。
- 影响：重复约 30-50 行边界处理；恶意或错误 endpoint 可让 models discovery 无界读取响应。
- 建议：抽取中立的受限正文读取器，调用方映射各自错误码；models endpoint 设置合理 JSON 上限。
- 风险：中。必须保留 caller abort、timeout、response-too-large 和连接失败之间的错误分类。
- 验证：content-length 预拒绝、chunked 超限、读取中 abort、timeout、空 body、非法 JSON。

### F-18 `SearchCorpus.mark` 每次扫描并重新规范化所有 URL

- 位置：`src/web-tools/search/search-corpus.ts:19-64`。
- 现状：`add` 以原始 URL 为 key；`markFetched`/`markCited` 规范化输入后，再遍历并重新规范化所有已发现 URL。
- 影响：每次标记为 O(U)，并重复 URL 解析。
- 建议：在 `add` 时规范化并以规范化 URL 为 key，标记时直接 `Map.get`。
- 可简化内容：删除 `mark` 中的全表循环；`usage` 也可在状态变化时维护计数，避免每次建立 values 数组和两次 filter。
- 风险：低至中。需先固定“不同原始 URL 规范化为同一 URL 时 discovered 数量”的现有期望。
- 验证：URL 大小写、默认端口、fragment、重复 URL、无效 URL 和 usage 计数。

### F-19 Worker task 队列使用数组头删和线性取消

- 位置：`src/worker-runtime/worker-task-pool.ts:40`、`src/worker-runtime/worker-task-pool.ts:74-82`、`src/worker-runtime/worker-task-pool.ts:129-166`。
- 现状：dequeue 使用 `shift`，queued abort 使用 `indexOf` + `splice`。
- 影响：出队和取消均为 O(n)。当前生产端约每 32 个文件创建一个 parser task，常规队列不大，因此优先级低于主扫描路径。
- 建议：使用 insertion-ordered `Map<id, task>`，首个 iterator entry 出队，按 id O(1) 删除。
- 风险：低，`Map` 保持 FIFO 插入顺序。
- 验证：`tests/worker-runtime/worker-task-pool.test.ts`、`tests/file-tools/grep-lifecycle.test.ts`，增加中间 queued task 取消后其余任务仍 FIFO。

### F-20 动态模型目录每次读取都重新进行 O(B*O) 合并

- 位置：`src/openai-compatible-provider/register.ts:146-173`。
- 现状：`getModels` 每次 clone baseline，并为每个 overlay 使用 `findIndex`。
- 影响：复杂度 O(B*O)，且 dynamicModels 不变时重复产生相同 catalog。
- 建议：dynamic directory 更新时缓存合并 snapshot；合并过程使用 id -> index `Map`，降为 O(B+O)；对外返回浅拷贝以防调用方修改。
- 风险：低至中。需确认 provider API 是否要求每次返回全新 model object，而不只是全新数组。
- 验证：overlay 覆盖顺序、新增模型、缓存刷新和调用方修改返回数组场景。

## 4. P2：冷路径或高语义风险候选

### F-21 Ambiguous edit hint 重复计算公共前后缀

- 位置：`src/file-tools/edit/hints.ts:34-70`。
- 现状：每个 left boundary 都为其它命中重新计算 common suffix/prefix，并线性查找 right boundary。
- 影响：近似上下文半长 500/1k/2k/4k/8k 时，实测约 10/29/122/334/1,348 ms，趋势接近 O(n²)。
- 建议：每对 occurrence 只计算一次 LCS/LCP；按 `leftCount` 建 suffix-max 所需 `rightCount`，boundary 按 count 直接索引。
- 风险：中。涉及最短可重试提示、Unicode code point 和重叠 occurrence。
- 定位：错误恢复冷路径，后于编辑成功路径。

### F-22 Telemetry candidate attribution 存在多层嵌套扫描和全量排序

- 位置：`src/telemetry-report/analyzers/candidate-observations.ts:89-105`、`src/telemetry-report/analyzers/candidate-observations.ts:170-213`、`src/telemetry-report/analyzers/candidate-observations.ts:250-311`。
- 现状：反复扫描 prior/forward calls；consumer、producer、target、candidate 多层嵌套；收集全部 match 后排序；compatibility 阶段再重复 filter attribution。
- 影响：合成数据中 200/400/800 groups 约耗时 25/80-94/299 ms。
- 建议：建立 target/file key 索引；用前向/反向预计算替代每个 producer 的 prior/next 扫描；使用单次 best match 代替保存后排序；按 producer 预分组 attribution。
- 风险：中至高。报告指标的 tie-break、window 和兼容输出必须完全保持。
- 定位：离线报告路径，先补等价测试和 benchmark，再重构。

### F-23 Telemetry candidate ranking 重复遍历 producer、evidence 和 candidate

- 位置：`src/telemetry-report/analyzers/candidate-ranking.ts`。
- 现状：多个统计阶段按 producer/evidence/candidate 重新匹配和聚合，存在 P*E*K 类型的重复扫描。
- 建议：按 producer/candidate key 建一次索引，在单个聚合 pass 中计算各指标。
- 风险：中至高。需要以现有报告 JSON 为黄金行为，并确认排序和浮点聚合顺序。
- 定位：与 F-22 一起设计，但分开提交以便验证。

### F-24 TUI 每次 snapshot 都扫描全部 session usage

- 位置：`src/tui/runtime.ts:395-427`。
- 现状：`collectUsage` 每次调用 `ctx.sessionManager.getEntries()` 并重新汇总所有 assistant message。
- 影响：长会话中，频繁 UI 状态变化会重复 O(S) 扫描。
- 建议：使用事件驱动的增量 accumulator，或至少按 session revision 缓存结果。
- 风险：高。branch、resume、compaction 和会话替换会让纯增量状态失效，必须有可验证的重建边界。
- 定位：暂缓，除非实际 profile 显示为可见热点。

### F-25 Prune preview 对 before、after 和公共前缀重复计 token

- 位置：`src/prune/service.ts:245-301`、`src/prune/prune.ts:210-226`。
- 现状：preview 分别统计 before、after、static prefix 和 common prefix，部分未变化消息会多次 tokenization。
- 建议：缓存按消息/内容计算的 token estimate；before/after 共享未变化消息结果，公共前缀复用同一 projection。
- 风险：高。token counter scope、confidence、message overhead、工具定义和 compaction 语义都必须进入 cache key。
- 定位：先 profile 和建立 projection 等价测试，不进入第一轮重构。

## 5. D：去重与净减代码行数

### D-01 四套配置分层校验与合并循环重复

- 位置：
  - `src/approval/config.ts:24-38`
  - `src/bash-tool/config.ts:25-39`
  - `src/tui/config.ts:24-38`
  - `src/web-tools/config.ts:66-80`
  - 可承载共享实现：`src/config-loader.ts`
- 现状：四个模块重复“逐层读取 -> 验证 partial -> merge -> 最终验证”的循环。
- 建议：增加 `loadValidatedMergedConfig`，接收 partial/complete validator，并保留每层 merge 前校验和诊断上下文。
- 收益：粗略估计净减 40-45 行，并统一层级错误行为。
- 风险：低至中。不能把校验推迟到 merge 后，否则会改变错误定位。

### D-02 LSP `withTimeout` 完全重复

- 位置：`src/lsp/client.ts:924-936`、`src/lsp/transport.ts:194-206`。
- 建议：提取 LSP 局部共享 helper。
- 收益：预计净减 10-12 行，统一 timer 清理和拒绝行为。
- 风险：低。

### D-03 Edit `findAll` 完全重复

- 位置：`src/file-tools/edit/command.ts:334-344`、`src/file-tools/edit/hints.ts:133-143`。
- 建议：提取 edit 模块内部共享 helper；F-06/F-21 改造时同步完成。
- 风险：低，需保留重叠匹配语义。

### D-04 C/C++ include 收集实现重复

- 位置：`src/code-index/adapters/c.ts:54-70`、`src/code-index/adapters/cpp.ts:85-101`。
- 建议：提取 `collectCStyleImports`，由两个 adapter 传入语言差异配置。
- 风险：低，避免把语言独有逻辑一并抽象。

### D-05 Edit/Write LSP post-write port 近似重复

- 位置：`src/file-tools/pi/ports/edit.ts:39-53`、`src/file-tools/pi/ports/write.ts:28-41`。
- 建议：提取共享 post-write helper，参数只保留 path、changed ranges 和调用上下文差异。
- 风险：低至中，必须保持 edit/write 各自错误和诊断包装。

### D-06 File-tools Pi 适配器重复构造失败结果

- 位置：`src/file-tools/pi/ports/` 下多个适配器。
- 现状：多处重复 `failedResult` envelope 和 open/dispose 边界包装。
- 建议：从 model-output 层导出一个失败结果 helper；只有在错误映射完全一致时才共享 open/dispose wrapper。
- 风险：中。过度抽象会隐藏不同工具的生命周期，优先只合并完全相同部分。

### D-07 Bash command facts 重复构造和 unwrap

- 位置：`src/approval/bash-parser.ts:368-387`。
- 现状：`facts` 和 `resolvedFacts` 都使用同一个 `{ program: commandBasename(program), args }` 调用 `unwrapCommand`，当前结果完全相同。
- 建议：删除 `resolvedFacts`，`commandEffectsStayTemporary` 直接使用 `facts`；或者如果设计上本应区分 literal/resolved facts，则先修正输入再保留两个名称。
- 风险：低，但应先用现有 approval 测试证明两者没有隐藏的可变副作用。

### D-08 受限响应正文读取可与 F-17 一并去重

- 位置：`src/web-tools/network/response-body.ts`、`src/usage/client.ts:490-506`。
- 建议：共享底层“读取 Uint8Array + byte limit + abort”实现，错误对象仍由各调用方构造。
- 收益：预计净减 30-50 行。
- 风险：中，不应为了减少行数破坏各域错误码。

### D-09 LSP symbol tree 遍历可与 F-16 一并去重

- 位置：`src/lsp/symbols.ts:137-158`、`src/lsp/code-analysis.ts:91-105`。
- 建议：共享最小的迭代 traversal primitive，而不是共享两种不同输出模型。
- 风险：中。qualified name 只由 code-analysis 需要。

整体估计：仅实施明确的 D 项，可净减少约 80-120 行；具体数字需以最终 diff 为准。性能重构的主要价值是降低复杂度和分配，不保证每一项都减少物理行数。

## 6. 建议实施顺序

### 阶段 A：文件主数据流

1. F-02 `sliceTextByLineRange` 游标化。
2. F-03 `describeText` 单次扫描。
3. F-01 长单行分段缓冲。
4. F-11 无 structure 时复用初次 slice。
5. 为上述路径补 microbenchmark 和回归测试。

原因：收益最大，模块边界集中，可用现有 text/content/read/grep 测试形成快速反馈。

### 阶段 B：Bash 与 Edit

1. F-04 Buffer 化输出捕获。
2. F-05 统一 capture 清理。
3. F-13 并行 virtualenv 探测。
4. F-06 单次计算 changed ranges。
5. D-03、F-21 视测试保护程度顺带处理。

### 阶段 C：Visibility 与并发正确性

1. F-07 预编译 path rules。
2. F-12 BFS 游标。
3. F-10 dirty + lazy evaluator。
4. F-08 approval 初始化状态。
5. F-09 LSP atomic admission。

F-08/F-09 应单独提交和验证，不与纯性能重构混在同一功能切片。

### 阶段 D：低风险去重

1. D-01 配置加载。
2. D-02 timeout。
3. D-04 C/C++ imports。
4. D-05/D-06 Pi ports。
5. D-07 command facts。
6. F-17/D-08 response body。

### 阶段 E：按 profile 决定

- F-14、F-16、F-18、F-19、F-20。
- F-22 至 F-25 暂不实施，先建立可重复 benchmark 和行为黄金测试。

## 7. 全量验证要求

每个功能切片先运行相关测试；全部修改完成后运行：

```sh
npm run typecheck
npm test
npm run test:coverage
```

另外应运行或新增以下针对性验证：

- 多尺寸无换行文件扫描 benchmark，确认近似线性增长。
- 前 10 行读取超大短行文件，确认不会物化整文件行数组。
- Bash 大输出、UTF-8 边界、astral 字符和异常清理。
- 大量 `replace_all` 的 changed ranges 与耗时。
- 多条 ignored path 规则下的 visibility evaluate benchmark。
- Approval/LSP 同 tick 并发回归。
- 检查最终 `git diff`，删除原型和调试输出，不降低覆盖率阈值。

## 8. 非目标

- 不做仅为缩短行数的压行、嵌套三元表达式或隐藏控制流。
- 不为未来可能需求建立通用框架。
- 不在缺少等价测试时重写 Telemetry、TUI、prune 的状态模型。
- 不通过扩大测试排除、降低覆盖率或删除断言规避失败。

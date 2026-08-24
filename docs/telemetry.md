# 本地遥测

遥测是本地、append-only 的工具调用事实，用来回答模型是否需要多文件 edit，以及模型实际看到的搜索候选是否被后续工具调用采用。它提供观测信号，不替代 benchmark，也不作因果结论。grep 不把 LSP 调用或引用关系伪装成检索来源。它们只影响候选的结构 tier。

采集失败、投影失败或写盘失败不得改变工具和 Pi 生命周期。系统不保存 prompt、工具输出正文、edit 内容、diff、搜索 query 或 shell command 原文。

## 数据与生命周期

只有至少完成一次工具调用的 Pi run 才写文件：

```text
~/.pi/telemetry/runs/<run_id>.jsonl
```

只有两类 record：

- `run`：session、cwd、时间，以及自动取得的 Git root、commit 和 dirty diff hash。
- `call`：完成调用的工具、时间、状态、耗时、repair、batch，以及少量专属事实。

Pi 的 `tool_execution_start` 建立内存 pending call，参数准备完成后只投影最终执行输入，首个 `tool_execution_end` 才触发 writer 与 Git provenance 初始化并写入 `run + call`。仅启动后退出或只有未完成调用的 run 不创建文件。进程退出前仍未完成的调用不补写。系统不维护 declared/executing/unfinished 状态机，也不恢复 pending 数据。

writer 与 Git provenance 在首个完成调用后于后台并行初始化，不阻塞 Pi 启动或工具完成事件。初始化期间完成的调用在内存中按序暂存，待 `run` header 写入后刷新。writer、Git 和报告模块都延迟到实际需要时加载。

collector 同时保留当前 `session_start` 以来的 record 内存视图，供 `/telemetry` 即时分析。切换 session 时清空。它不扫描或恢复旧 run，不改变 JSONL 作为持久化事实源的地位。

collector 查询和 live report 构建不依赖 UI。报告 DTO 可直接 `structuredClone` 和 JSON stringify/parse。未启用 telemetry、空 session 和失败投影都使用结构化降级状态。TUI viewer 与非 TUI summary formatter 消费同一 DTO，extension 只选择 presentation。

`message_end` 只用于识别同一 assistant message 中的并行 batch。`turn_start` 只给后续 call 附加模型和 thinking，不单独落盘。

系统没有 telemetry schema version、behavior version、report version 或 manifest。格式发生破坏性变化时直接丢弃旧的本地观测数据，不提供迁移或兼容层。Git 和 definition hash 都是自动观测值，不需要人工维护。

## 工具接入

仓库内模型工具统一通过 `registerObservedTool` 注册。它组合已有的 argument repair，并通过 Pi runtime EventBus 发布可选的 `input`、`result` 投影。collector 的 ready 握手保证工具和 telemetry extension 可以按任意顺序加载。工具 execute 不会被 telemetry wrapper 包裹。

```ts
const searchTelemetry = defineToolTelemetry<SearchParams, SearchDetails>({
  input: (params) => ({
    fields: { query_chars: params.query.length },
    targets: [{ kind: "directory", value: params.path }],
  }),
  result: (_params, result) => ({
    fields: { match_count: result.details.matches.length },
    candidates: result.details.matches.map((match, index) => ({
      kind: "file",
      value: match.path,
      rank: index + 1,
      sources: match.sources,
    })),
  }),
});

registerObservedTool(pi, { tool, repair, telemetry: searchTelemetry });
```

没有专属投影的 host 工具仍会记录完成状态、耗时和输出大小。`definition_hash` 只标识模型可见 name、description、parameters 和 prompt fields 的变化，不代表实现版本，也不作为默认行为分组。

投影只支持：

- `fields`：少量标量或字符串数组。单位写在字段名中。
- `targets`：调用明确访问的文件、目录、region 或 URL。
- `candidates`：模型实际看到的候选顺序、资源和来源。

投影边界限制字段、数组、资源数量和字符串长度。显式文本摘要只计算字符数和行数。越界字符串额外保留 SHA-256。异常与限幅分别写入 `telemetry_<scope>_error`、`telemetry_<scope>_limited`。input projector 只消费验证后的执行参数。执行或参数校验异常不会调用 result projector。projector 只收到按访问惰性创建的只读视图，不会深拷贝未访问的大 payload，错误也不会逃逸到工具执行路径。

grep 候选使用 `verified` / `related` group。`query_mode` 区分 `regex` 与 evidence-gated `literal_fallback`，候选 source 进一步区分 `text-regex`、`text-literal` 和 `text-lexical`。专项字段记录 `text_hit_count`、返回的两类候选数、搜索/AST 工作量，以及正文 hit、related anchor、related 静默限额和 AST 大文件跳过的内部容量计数。这些字段不保存 query。

grep 排序事实分为两层：

- 调用级：`ranking_algorithm`、cap 前后候选数、选择数、tier 数、top-tier 候选数、relevance head、MMR 选择/替换数，以及纯 relevance 前缀和最终选择的文件数。
- 候选级：模型可见 rank、选择前 relevance rank、tier、主/辅助连续分数及 `head` / `mmr` 选择阶段。

当前 `semantic-tier-bm25f-rrf-mmr-v2` 先组合查询层级与 `called`、`referenced`、`defined` 权威等级。主分数使用 BM25F，即 BM25 的多字段扩展。辅助分数使用按来源族分组的倒数排名融合（RRF）。连续分数只在采用同一算法和同一查询的候选之间有意义。

跨算法比较主要使用以下指标：

- Hit@K：前 K 个结果中是否存在被采用的候选。
- 平均倒数排名（MRR）：首个被采用候选的倒数排名均值。
- 归一化折损累计增益（nDCG）：考虑位置折损后的排序质量。
- 下游采用情况。

算法更换时必须使用新的 `ranking_algorithm`，不得复用旧标识。

## 报告

当前 session 的实时报告：

```text
/telemetry
```

命令对 collector 快照复用离线报告的同一套 analyzer，并在只读浮层显示工具统计、edit 多文件需求和模型可见候选采用情况。只统计已完成调用。正在执行的调用只显示数量。视图不写入会话历史，也不进入模型上下文。

离线报告：

```text
npm run telemetry:report -- [--input DIR] [--output DIR]
                           [--tool NAME] [--commit HASH]
                           [--dirty true|false] [--from ISO] [--to ISO]
```

输出 `report.json` 与 `report.html`。报告只包含：

- 每个工具的调用量、成功率、错误及其结构化错误码计数、耗时、截断和 repair。HTML 的“工具性能”表可将鼠标悬浮在错误率上查看各错误原因的出现次数。
- find/grep 的输入路径数量、scope 数量、部分失败 scope 数量和多 scope 调用数。正常数组调用与 repair 的 `split_path_list` / fanout 摘要可区分统计。
- edit batch 的多文件比例、部分失败、每批文件/调用数，以及多文件接口可能减少的调用数。
- grep 专项执行链：direct hit、零 hit 后的 related fallback、仍无结果、related 找回率、verified/related 在下次搜索前和 productive 窗口内的采用、AST/LSP 参与、结果限制与内部容量压力。
- grep 排序专项：按 `ranking_algorithm` 分组的候选池、tier、MMR 替换、文件多样性增益、Hit@1/3/5/10、MRR、nDCG@1/3/5/10，以及按 tier、`head` / `mmr` 阶段的采用率、原始 relevance rank、选择后 rank 提升和分数分布。缺少新版排序事实的旧调用单独计数，不混入算法对比。
- find/grep/websearch 的调用量、扫描文件投影总数及其覆盖调用数、有候选调用、至少一个候选被采用的有效搜索、候选采用率，以及进入 read/webfetch、edit/write 或其他工具的候选数。HTML 按搜索工具和 candidate group 展示漏斗。
- find/grep/websearch 候选的即时、下次搜索前和 productive 采纳情况，以及模型可见细分来源的参与贡献。grep 只投影最终模型可见 region 的检索来源，不投影未形成可见结果的内部 hint。
- `websearch` 记录主要提供方、查询类型、计算首调用接受率所需的事实、正式提供方调用数和回退原因。它还记录次要提供方新增结果、缓存或语料库复用、提供方延迟和错误类型、语料库抓取与引用计数，以及近似查询改写。它不记录 API 密钥、完整查询或响应正文。URL 后续进入 `webfetch` 或引用环节的采用率继续由候选转化链计算。

候选转化采用小而明确的启发式：同 run 后续 10 个调用、5 分钟内首次命中候选资源的 target。同一并行 batch 不算消费。多来源候选会分别归因到每个来源，来源数据不能直接相加。nDCG 将唯一归因的下游采用视为二元相关性。它只能评价模型实际看到的列表，不能证明未展示候选无关。遥测用于发现真实 workload 和提出排序假设，排序是否改善仍由固定 workload benchmark 验证。

报告不提供通用 workflow、transition、fallback、baseline/candidate 统计框架或任意字段查询层。需要新指标时先提出具体工具设计问题，再扩展最小事实和专项 analyzer。

# 本地遥测

遥测是本地、append-only 的工具调用事实，用来回答两个主要问题：模型是否需要多文件 edit，以及 find/grep 中 repo-map 与 LSP 等候选来源的排序是否被后续工具调用采用。它提供观测信号，不替代 benchmark，也不作因果结论。

采集失败、投影失败或写盘失败不得改变工具和 Pi 生命周期。系统不保存 prompt、工具输出正文、edit 内容、diff、搜索 query 或 shell command 原文。

## 数据与生命周期

每次 Pi run 写一个文件：

```text
~/.pi/telemetry/runs/<run_id>.jsonl
```

只有两类 record：

- `run`：session、cwd、时间和自动取得的 Git commit/dirty diff hash。
- `call`：完成调用的工具、时间、状态、耗时、repair、batch，以及少量专属事实。

Pi 的 `tool_execution_start` 建立内存 pending call，参数准备完成后只投影最终执行输入，`tool_execution_end` 直接写入一条 `call`。进程退出前仍未完成的调用不补写；系统不维护 declared/executing/unfinished 状态机，也不恢复 pending 数据。

writer 与 Git provenance 在后台并行初始化，不阻塞 Pi 启动；初始化期间完成的调用在内存中按序暂存，待 `run` header 写入后刷新。writer、Git 和报告模块也都延迟到实际需要时加载。

collector 同时保留当前 `session_start` 以来已成功写入 record 的内存副本，供 `/telemetry` 即时分析；切换 session 时清空。它不扫描或恢复旧 run，不改变 JSONL 作为持久化事实源的地位。

`message_end` 只用于识别同一 assistant message 中的并行 batch。`turn_start` 只给后续 call 附加模型、thinking 和当前 repo-map 状态，不单独落盘。

系统没有 telemetry schema version、behavior version、report version 或 manifest。格式发生破坏性变化时直接丢弃旧的本地观测数据，不提供迁移或兼容层。Git 和 definition hash 都是自动观测值，不需要人工维护。

## 工具接入

仓库内模型工具统一通过 `registerObservedTool` 注册。它组合已有的 argument repair，并登记可选的 `input`、`result` 投影；工具 execute 不会被 telemetry wrapper 包裹。

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

- `fields`：少量标量或字符串数组；单位写在字段名中。
- `targets`：调用明确访问的文件、目录、region 或 URL。
- `candidates`：模型实际看到的候选顺序、资源和来源。

投影边界限制字段、数组、资源数量和字符串长度。显式文本摘要只计算字符数和行数；越界字符串额外保留 SHA-256。异常与限幅分别写入 `telemetry_<scope>_error`、`telemetry_<scope>_limited`。projector 只收到按访问惰性创建的只读视图，不会深拷贝未访问的大 payload，错误也不会逃逸到工具执行路径。

## 报告

当前 session 的实时报告：

```text
/telemetry
```

命令对 collector 快照复用离线报告的同一套 analyzer，并在只读浮层显示工具统计、edit 多文件需求，以及 repo-map/LSP 候选排序。只统计已完成调用；正在执行的调用只显示数量。视图不写入会话历史，也不进入模型上下文。

离线报告：

```text
npm run telemetry:report -- [--input DIR] [--output DIR]
                           [--tool NAME] [--commit HASH]
                           [--dirty true|false] [--from ISO] [--to ISO]
```

输出 `report.json` 与 `report.html`。报告只包含：

- 每个工具的调用量、成功率、错误、耗时、截断和 repair。
- edit batch 的多文件比例、部分失败、每批文件/调用数，以及多文件接口可能减少的调用数。
- find/grep/websearch 候选的 conversion@K、MRR 和下游消费工具；每个细分来源使用同一组指标，并将 `repo-map-*`、`lsp-*` 分别聚合为 `repo-map`、`lsp` 来源族。

候选转化采用小而明确的启发式：同 run 后续 10 个调用、5 分钟内首次命中候选资源的 target；同一并行 batch 不算消费。多来源候选会分别归因到每个来源，来源数据不能直接相加。它用于发现真实 workload 和提出排序假设。排序是否改善由固定 workload benchmark 验证。

报告不提供通用 workflow、transition、fallback、baseline/candidate 统计框架或任意字段查询层。需要新指标时先提出具体工具设计问题，再扩展最小事实和专项 analyzer。

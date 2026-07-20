# 本地遥测

遥测保存本地、append-only 的一阶事实，用于评估和改进工具定义、行为、配置与 instrumentation。采集失败不得改变 tool、turn 或 session 行为；采集端不推断工作流，也不保存工具输出正文。

## 无版本号的可追溯身份

系统不维护 schema version 或报告版本号。语义对象使用 SHA-256 内容寻址，并把不可变描述写入：

```text
~/.pi/telemetry/manifests/<kind>/<hash>.json
```

manifest kind 包括 `collector_contract`、`tool_behavior`、`tool_definition`、`tool_instrumentation`、`tool_config` 和 `analysis_contract`。描述包含机器可读契约、相关本地源码 import closure 的逐文件 hash，以及安全化后的有效配置。由此可以从事件或报告中的 hash 找回当时的确切口径，不依赖 Git tag、仓库版本号或人工常量。

工具配置中的 secret 值不明文写入 manifest。配置读取失败使用独立的失败身份，并产生 `config_capture_failure`，不会与正常配置混在一起。未接入专用 instrumentation 的 host tool 仍以其 definition 派生 behavior 身份，使模型可见定义变化能够形成新切片；未知实现和配置保持 `unavailable`。

collector contract 描述事件字段、生命周期、outcome、计时与投影规则，并包含采集实现源码闭包。分析 contract 同样绑定分析实现源码。原始 reader 容忍未知字段和未知事件；缺失或非法 hash 会得到记录级诊断身份，绝不会被归入共享的 `unversioned` 桶。

## 存储、顺序与资源边界

每个采集进程生成 `run_id`，并使用独立 ledger：

```text
~/.pi/telemetry/sessions/<session>.<run>.jsonl
~/.pi/telemetry/sessions/<session>.<run>.health.jsonl
```

公共 envelope 包含 `id`、`session_id`、`run_id`、`stream_id`、`sequence`、`timestamp`、`collector_contract_hash` 和 `context`。`sequence` 只要求在 `session_id + run_id + stream_id` 内连续；main、health 和 emergency stream 各自计数，因此并发进程和 sidecar 不会制造伪冲突。writer 使用逐行持久化 append、文件锁和独立 health sidecar。同一同步 burst 会合并为一次加锁、append 和 fsync；记录仍各占一行并保持 sequence 顺序。

采集启动只恢复当前 session 的文件，不扫描全部历史，并只保留按时间最近的 live 上限。JSONL 按行读取，不再把单个 ledger 正文整体复制进内存。live store 默认最多保留 50,000 条记录，writer 默认最多排队 10,000 条；截断或背压丢弃分别暴露为 `live_store_truncated`、`dropped_writes` 和 collection health，而不是静默耗尽内存。离线报告读取完整输入目录并保留完整 canonical facts，因此其内存仍随目录历史量增长；数据量很大时应按目录分区后分别生成报告。

报告分析与 TUI 仅在首次执行 `/telemetry` 时加载，不进入普通启动路径。源码身份缓存文件摘要、import 解析和依赖闭包，并用文件 mtime 与大小失效；工具 definition token 估算按模型与 definition identity 复用。进程内 runtime 事件在 adapter 边界完成限制与校验后直接传递，外部注入事件仍执行完整克隆和解码。

所有 adapter payload 在进入 runtime channel 前统一限制：最大深度 8、节点 4096、字符串 4096 字符、数组 256 项、对象 128 个键。超限数据保留有限前缀/摘要并标记 `projection_limited`；投影异常标记 `projection_failed`。JSONL 单行超过 1,000,000 字符会按无效行计数。

## 工具接入

仓库内模型工具统一使用 `registerObservedTool`。基础接入只提供工具和行为源码；默认 adapter 不记录输入或工具 details，但仍采集 exposure、repair、approval、执行状态、时延、错误和输出大小：

```ts
registerObservedTool(pi, {
  tool,
  source: import.meta.url,
  config: loadConfig, // 可选；只返回影响行为的有效配置
  repair,             // 可选
});
```

需要工具专属维度时再定义 adapter。`input` 同时投影原始 requested input 和实际 executed input；只有两者语义确实不同时才分别实现 `requested` 或 `executed`。`result` 只返回 payload-free facts：

```ts
export const searchTelemetry = defineToolTelemetry<SearchParams, SearchDetails>(import.meta.url, {
  input: projectSearchInput,
  result(_params, result) {
    return { metrics: searchMetrics(result.details) };
  },
});
```

输入投影是显式 allowlist。不得根据参数 schema 自动持久化全部参数。每个 adapter 使用自己的入口文件；可复用逻辑放入共享 helper，使单工具修改只改变该工具的 `instrumentation_hash`，helper 修改则改变所有真实消费者。行为由多个独立 runtime 组成时，`source` 可传 URL 数组。

所有工具共享每个 Pi 实例唯一的 telemetry coordinator；新增工具不会新增全局 lifecycle handler。普通 `pi.registerTool` 注册的外部或 host 工具仍有通用生命周期事实，但行为实现、instrumentation 和配置身份保持 `unavailable`。

## 原始事件与生命周期

事件集合：

```text
session_start
turn_start
tool_call_start
tool_execution_start
tool_call_end
turn_end
collection_health
session_end
```

`before_agent_start` 只在 context 中记录原始用户 prompt 的 hash、字符数、token 估算方法、图片数和粗粒度 shape，不保存 prompt。`turn_start` 记录完整 tool exposure、序列化模型可见 definition 的 token 估算，以及 repo-map 的 enabled、freshness 和 map identity。definition method 带 `serialized_tool_definition:` 前缀，明确它不是 provider 最终 system prompt 的精确计费 token。

分析按 `session_id + run_id + tool_call_id` 合并三个调用事件。canonical call 使用两个互不混淆的维度：

```text
phase:           declared | executing | ended
terminal_status: completed | blocked | validation_failed | unfinished
```

`tool_call_start` 会立即通过已注册 adapter 保存 requested allowlist 投影，因此即使随后崩溃，declared call 仍保留当时已知且允许记录的输入；原始参数不直接落盘。只有 start 的调用仍会进入数据集。由此可以分别统计 execute 前未完成、execute 中断、validation failure 和 block；不会再用一个互斥 enum 同时表达“走到哪里”和“如何结束”。wall clock 只用于事件时间，duration 使用单调时钟。

## 工具切片与 observation

每次 exposure 和 call 保存：

- `behavior_hash`：行为源码闭包、definition、repair 和执行入口；
- `definition_hash`：模型可见 name、description、parameters、prompt snippet/guidelines；
- `instrumentation_hash`：adapter 源码闭包与投影/观测能力；
- `config_hash`：安全化后的当前有效行为配置。

严格切片为：

```text
tool_name + behavior_hash + instrumentation_hash + config_hash
```

typed metric 自带 `kind`、`aggregation` 和可选 `unit`。采集端 schema 语境作用于 `tool_name + instrumentation_hash + metric_name`；session 恢复会在逐行扫描时保留完整历史的最早 schema 摘要，即使 live records 随后按上限截断也不会丢失语境。冲突只写 `metric_schema_conflict`，原始观测值不丢弃；分析端在严格切片内决定能否聚合。

通用 observation 支持 `metrics`、`references`、`attributes`、`measurements` 和 `stages`。报告会聚合 scalar attribute 分布、measurement 数值与单位冲突、stage 出现次数/status/duration/measurement。结构化过程不应编码进动态 metric name。

## 报告与统计语义

`npm run telemetry:report` 生成唯一完整数据源 `report.json`，以及 `report.html`、`slices.csv` 和 `calls.csv`。离线生成会先持久化 analysis manifest；失败时不发布一个无法追溯的报告。

查询支持 tool、slice、config、collector contract、model、thinking、toolset、workload hash、workload shape、repo-map enabled/freshness/identity、project、environment 和时间范围。默认只选择每个工具最近 exposure 或 call 对应的 contract 与严格切片，包括“只有 exposure、尚无调用”的新 definition。

每个 rate 都明确输出 `numerator`、`samples`、`missing`、`missing_rate`、可用时的 `value` 和 Wilson interval。数值统计无样本时省略 min/max/mean/p50/p95，不伪造 0。token 统计保留 estimator method 及各方法的样本/总量；不同 estimator mix 不直接比较。频率分布最多保留 255 个最高频值，剩余观测合并到保留键 `__telemetry_other__`，防止任意 attribute 值使报告基数无限增长。

主要指标包括：

- exposed turns、selected turns、selected calls、selected-turn rate、calls per exposed turn；
- definition token cost 与 unused definition token cost；
- validation failure、repair、repair operation；
- requested/executed 差异；
- approval observation、ask、user allow、block 与等待时间；
- start-to-execute、execution 与总调用时长；
- unfinished、truncation、error code、batch 和真实执行区间重叠率；
- repo-map 和通用 observation 分布。

`execution_success_rate` 只表示执行结果。candidate conversion、按 source 归因的 conversion 次数、重复调用、fallback、transition、near retry 和 oscillation 明确标记为 `heuristic: true`；归因次数可能因一个 candidate 拥有多个 source 而高于唯一 candidate 数，不能当作去重转化数。缺失事件时间、跨 branch、同 batch、执行重叠或资源发生变化时会排除相应因果链。

baseline/candidate 首先检查 tool、instrumentation、config，以及 collector contract、model、thinking、toolset、精确 workload hash、workload shape、project 和 environment 分布。config 变化视为混杂，不能与 behavior 变化一起解释。每个指标另检查 schema、单位、缺失率、token estimator、样本量和独立 session 数。存在任一问题时不产生 effect；可比较时 rate 给出差值，延迟给出 median difference，并对 success/duration 使用按 session 聚类的确定性 bootstrap 区间。报告只应视为观测性证据，不是随机实验结论。

HTML 中的筛选器只控制去除输入正文后的 call explorer。聚合表和 comparison 是 analyzer 生成的审计快照，不会在浏览器内用另一套简化算法重算；更换 baseline/candidate 或聚合过滤条件应重新运行 CLI。

## Collection health

health 覆盖 JSONL、sequence、生命周期、投影限制/失败、metric schema、writer、manifest、live 截断和 runtime channel。顶层边界还会记录：

```text
collector_handler_failure
session_hydration_failure
identity_resolution_failure
config_capture_failure
runtime_event_drop
context_capture_failure
```

主 writer 失败写独立 health stream；collector 尚未建立时使用 emergency stream，并在 shutdown 尝试 flush。live 报告标为 `live_observed`，同时展示 pending、failed、dropped 和 omitted 数量，避免把尚未持久化的内存事实冒充 durable snapshot。

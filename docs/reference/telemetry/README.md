# 本地遥测

遥测记录工具调用事实，用于分析成功率、耗时、参数修复、编辑批次和搜索结果采用情况。

## 数据

至少完成一次工具调用后，当前运行写入：

```text
~/.pi/telemetry/runs/<run_id>.jsonl
```

| 记录 | 内容 |
| --- | --- |
| run | 会话、工作目录、时间、Git 根目录、提交和差异哈希 |
| call | 工具、状态、耗时、修复、批次和专属事实 |

采集器不保存提示词、工具结果正文、编辑文本、diff、搜索词和 Shell 命令原文。目标路径与 URL 等资源标识按投影规则保留。

`duration_ms` 来自 SDK `tool_execution_end.durationMs`，表示 execute 耗时。未执行调用省略耗时，仍计入调用量和成功率。事件时间差与执行耗时应分开理解。

嵌套调用保存 `parent_call_id`，计入工具执行统计，模型候选采用和助手批次分析排除脚本子调用。

所选模型与实际响应模型分别记录。费用使用 SDK 汇总，避免重复累计嵌套用量。

## 生命周期

开始事件创建内存记录，首个完成调用延迟初始化 writer 和 Git 信息，再按顺序写入。未完成调用不补写，采集或写入失败不影响工具执行。

采集器保留当前会话启动以来的内存记录，切换会话后重新统计。实时报告直接分析该快照，历史文件由离线报告读取。

## 报告

```text
/telemetry
```

TUI 显示浮层，GUI 显示会话信息页，其他交互入口返回通知。实时与离线报告共用分析器。

```bash
bun scripts/generate-telemetry-report.mjs --input /path/to/runs --output /path/to/report
```

可按工具、提交、dirty 状态与起止时间筛选。输出 `report.json` 和 `report.html`。

主要指标：

- 调用量、成功率、错误码、耗时、截断和修复。
- 搜索范围、部分失败和结果采用。
- edit 批次的多文件比例与失败情况。
- grep 的正文命中、相关回退、结构增强、排序与容量。
- 候选的 Hit@K、MRR、nDCG 和下游使用。

候选采用使用同 run 后续 10 次调用、5 分钟内首次匹配目标的规则，同一并行批次不算消费。指标反映已展示结果的使用情况，排序改进还需固定任务基准验证。

## 接入

工具通过 `createToolRegistrar()` 绑定当前遥测服务，投影使用 `satisfies ToolTelemetry<...>` 校验类型。注册信息和修复观察直接传递，不经事件总线。字段分为：

- `fields`：少量标量或字符串数组。
- `targets`：调用访问的文件、目录、区域或 URL。
- `candidates`：模型实际看到的候选及顺序。

投影有数量和长度上限，只读取所需数据。修复观察器提供结构操作摘要，执行计时使用 SDK 事件。

实现位于 `src/harness/telemetry/` 和 `telemetry-report/`。排序含义见[文件工具排序](../file-tools/ranking.md)，计数方法见[词元估算](../statistics/token-counter.md)。

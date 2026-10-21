# 统计与上下文

## 会话统计

`/stats` 在 TUI 打开只读浮层，GUI 在会话信息栏显示统计。

当前请求的上下文分项使用 SDK 投影，遵循上下文编辑、压缩和跨模型思考过滤。分项词元由[计数器](token-counter.md)估算并带 `~` 标记。

会话总用量包括助手响应、缓存保温、压缩摘要、分支摘要和工具报告用量。最近一轮、平均每轮和缓存命中率只统计对话中的助手请求。费用为估算值。

统计由 `collectStatsSnapshot()` 生成可序列化快照，界面只负责展示。

## 专题

- [套餐用量与 API 余额](usage.md)
- [词元估算](token-counter.md)
- [上下文裁剪](prune.md)
- [工具遥测](../telemetry/README.md)

实现位于 `src/harness/stats/`、`usage/`、`prune/` 和 `token-counter.ts`。

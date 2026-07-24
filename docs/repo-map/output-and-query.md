# Repo Map 查询与输出

Repo Map 查询只读取已经提交的 generation。它不在一次模型工具调用中执行完整仓库扫描。

查询传播、seed、候选去重和 `find`/`grep` 排序见 [query-and-ranking.md](query-and-ranking.md)。

## 查询来源

查询可以使用：

- file path 和 symbol alias。
- symbol 定义、引用和调用关系。
- imports、exports 和注册关系。
- architecture node。
- test node。
- evidence 指向的源代码范围。

这些来源用于生成候选和上下文；最终正文命中仍由 File Tools 的实时读取或搜索确认。

## Read context

`read` 可以请求与当前文件、范围或 symbol 相关的结构上下文。输出应优先包含：

- 当前 symbol 或范围。
- 关系类型和目标。
- 可验证的文件路径与 source range。
- 简短的调用或测试摘要。

## Mutation impact

mutation impact 用于提示一个修改可能影响的：

- references。
- callers/callees。
- tests。
- registration 或 configuration。

它是影响分析，不是编译器或完整测试结果。实际修改后仍应使用 `read`、`grep` 和测试验证。

## Budget 和截断

默认输出预算由 `read_context_token_budget` 和 `mutation_impact_token_budget` 控制。候选收集还有独立上限，避免为了渲染少量文本而遍历无限关系。

预算不足时优先保留：

1. 当前目标和直接关系。
2. 带 evidence 的候选。
3. 稳定、可解释的摘要。

截断应在结构化结果中明确标记，不把不完整列表渲染成完整结果。

## 失败边界

以下情况应退回基础 File Tools 或返回明确状态：

- activation 不存在。
- generation 与 current pointer 不匹配。
- 请求路径在 repository 外。
- generation stale 或 unavailable。
- evidence 指向的文件已经变化。

Repo Map 结果不得绕过 path guard、ignore 或 blocked path 检查。持久化 generation 和缓存校验见 [storage-and-errors.md](storage-and-errors.md)。

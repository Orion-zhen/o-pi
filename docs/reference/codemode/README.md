# Codemode

Codemode 使用 Pi 的脚本执行与工具发现能力。TUI、Web、Desktop 和无界面入口共用扩展，默认关闭，开启后固定使用 only 模式。

## 启用

在 `settings.json` 中加入：

```json
{ "defaultTools": ["+codemode"] }
```

也可使用 `/tools` 或 CLI `--tools +codemode`。恢复会话时，增减选择作用于历史工具集合。

开启后，普通工具通过脚本调用，model-only 工具保留直接声明，发现使用脚本的 `searchTools()`。关闭后恢复普通声明并保留其他工具选择。

`codemode` 和 `deferred` 暴露的工具即使未勾选，仍可被脚本调用。隐藏工具不可发现或调用。

## 工具发现

普通模式在存在已注册但尚未加载的延迟工具时自动启用 `tool_search`，候选全部加载或隐藏后关闭。原生搜索采用 BM25，默认最多加载 8 个，查询使用工具名或英文关键词。

Codemode 中 `searchTools()` 搜索脚本可调用工具并返回签名，不改变激活状态。结果通过 `text()` 或顶层 return 返回模型。

工具目录、签名和预算由 SDK 生成，`codemode.inlineBudget` 默认约 3000 tokens。模型能力通过原生 `models` API 提供，支持分类和图片生成。

检查工具存在性使用 `"name" in tools`，访问缺失成员会抛错。

## 结果

| 工具 | 脚本返回 |
| --- | --- |
| bash | output、status、exit_code、wall_time_seconds、truncated、capture_complete，可含 full_output_path |
| find | matches、total_matches、truncated，可含 scope_errors |
| grep | regions、truncated，可含 scope_errors |
| websearch | results，包含 title、url、snippet |
| read | 文本字符串，或图片、PDF 对象 |

Bash 原始文本最多 1 MiB，超限保留头尾。非零退出、超时和取消通过字段表示，脚本检查 status 与 exit_code。审批拒绝或没有结构化结果的失败会拒绝 Promise。

read 图片可传给 `image()` 或 `models.classify()`，PDF 从 content 中选择图片块。图片 Base64 应通过图片接口传递。

skill 和 subagent 为 model-only，需由模型直接调用。

## MCP

MCP 的 codemode 和 deferred 暴露方式只控制工具发现，不自动切换会话模式。普通模式由 tool_search 加载，脚本模式由 searchTools 查询签名，describeNamespace 读取服务说明。

服务连接、等待、认证和取消由 SDK 处理。配置和可见性见 [MCP](../mcp/README.md)。

## 执行与展示

嵌套调用经过 SDK 参数校验、审批、执行和结果钩子。QuickJS 限制脚本环境，宿主工具继续使用进程的文件、网络与执行权限。`models.*` 使用模型运行时，不经过工具审批。

GUI 按父子关系展示调用，保留手动展开状态。已完成子调用从 SDK nestedCalls 恢复，成功写入的 diff 另存界面专用会话条目。

遥测记录 parent_call_id，费用读取 SDK 汇总的父结果。嵌套记录的耗时可能含排队和审批，应与工具 execute 耗时分开使用。

## 打包与验证

Bun 产物内嵌 QuickJS WASM 和 worker，Desktop 分发独立 worker 与 WASM。真实二进制用例位于 `tests/cli/cli.test.ts` 和 `tests/cli/codemode-mcp.test.ts`，GUI 交互位于 `tests/gui/frontend/features/chat/tools/codemode.e2e.ts`。

性能比较应采集实际请求中的工具声明与结果，注册定义估算无法代表 Codemode 最终目录成本。

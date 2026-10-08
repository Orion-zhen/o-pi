# Codemode

复用 Pi 的 `codemode` 和 `tool_search`，不维护脚本调度器。TUI、无界面子进程、Web 和 Desktop 共用固定为 `only` 模式的 codemode 内置工厂。默认不启用。

## 启用

在 `~/.pi/agent/settings.json` 中增补：

```json
{
  "defaultTools": ["+codemode"]
}
```

单次 CLI 调用使用 `--tools +codemode` 在默认集合中加入脚本入口，或使用 `--tools read,find,grep,bash,codemode` 替换整个集合。CLI 选择优先于 `defaultTools`。当前分支的手动选择优先。`extensions: ["-builtin:codemode"]` 可禁用内置扩展。

opi 中启用 codemode 即使用 `only` 模式，忽略设置中的 `codemode.mode`，不提供原生 `on` 模式。所有非 `model-only` 工具不再单独向模型声明，包括已激活的脚本专用和延迟工具。其调用契约由 codemode 提供。`model-only` 工具仍直接向模型声明，但 `tool_search` 从启用集合移除，发现工具统一使用脚本内的 `searchTools()`。模型绕过脚本直接调用普通工具时会被阻止，脚本内嵌套调用不受此限制。关闭 codemode 后恢复普通工具声明，不改变其他工具的选择状态。

不要把 `/tools` 的未勾选理解为权限拒绝，`codemode`、`deferred` 曝光的工具仍可被脚本调用。

## 模型可见接口

codemode 使用原生 `description`、`promptSnippet`、`promptGuidelines` 和 `prepareLoadout` 生成的工具目录，不维护另一套提示词或目录算法。opi 只覆盖 `hiddenDeclarations`，保留更严格的 `only` 模式。schema、执行、审批、取消、会话存储和结果格式继续由 SDK 提供。

- 开放原生 `models` API，支持模型目录、分类和图片生成，复用会话认证。能力说明和参考文档入口完全沿用原生提示词，不额外追加。
- 原生 `promptGuidelines` 在 codemode 启用时由系统提示词收集到 `tool_policy`。
- 内联目录预算默认约 3000 tokens，可通过 `codemode.inlineBudget` 调整。分组、预算分配、签名和 MCP 共享类型均由上游生成。延迟工具不内联，不因其后台注册改变目录。
- 检查工具是否存在使用 `"name" in tools`。访问不存在的成员会抛错，不能使用 `typeof tools.name` 探测。

## 普通模式的工具发现

`tool_search` 是自动入口，不保存独立开关。普通模式下，存在已注册且尚未激活的 `codemode` 或 `deferred` 工具时启用。候选全部加载或隐藏后关闭，新候选出现后重新启用。工具选择器只显示其自动状态，保存默认工具时不写入此入口。禁用 `builtin:tool-search` 扩展可移除该能力。

搜索完全复用 Pi 原生 schema、BM25、参数验证和结果，默认最多加载 8 个，`limit` 可指定正整数上限。没有精确名称优先的特殊分支。查询使用工具名或英文关键词，上游分词不支持纯中文查询。结果包含名称和简短说明，完整契约由下一次请求的工具声明提供。已加载工具的激活状态沿用 SDK 的会话分支记录，不自动卸载。

codemode 下禁用 `tool_search`，返回普通模式时重新计算搜索可用性。脚本的 `searchTools()` 默认返回最多 8 个含签名的结果，能搜索脚本可调用的已加载和未加载工具，不改变激活状态。需要用 `text()` 或顶层 `return` 输出给模型。

## MCP 与模式

三端共用原生 MCP 工厂的模式适配。服务配置的 `codemode`、`deferred` 不会切换会话模式或打开另一种模式的入口。`direct` 仍直接加载，`hidden` 仍不可发现或调用，不改写用户的 MCP 配置。`autoEnableCodemode` 不决定 opi 的会话模式，模式只由 codemode 工具选择决定。

MCP 默认 `codemode` exposure 的工具在 SDK 内注册为延迟工具，普通模式可通过 `tool_search` 加载后直接调用。`codemode-deferred` 是 `codemode` 的上游别名。脚本模式通过 `searchTools()` 找签名，通过 `describeNamespace()` 读取完整服务说明。实际开放的间接 MCP 工具按命名空间生成紧凑 `mcp_servers` 摘要，不在工具描述中重复服务目录。

搜索可用性只看已注册工具，不维护连接、失败或认证状态。非 direct 服务仍在后台连接，注册前不会据配置提前启用搜索，注册后自动更新。连接、认证、调用前等待、取消和错误处理继续由 SDK 负责。外部扩展改变工具后，最迟在下一次提示或模型回合开始时更新搜索入口。

## 结果与边界

模型直接调用时继续接收紧凑 `content`，脚本通过 `outputSchema` 接收最小 `structuredContent`：

| 工具 | 脚本结果 |
| --- | --- |
| `bash` | `output`、`status`、`exit_code`、`wall_time_seconds`、`truncated`、`capture_complete`，以及保留日志时的 `full_output_path` |
| `find` | `matches[{path,kind}]`、`total_matches`、`truncated`，以及部分失败时的 `scope_errors` |
| `grep` | `regions[{path,start_line,end_line,symbol?,lines}]`、`truncated`，以及部分失败时的 `scope_errors` |
| `websearch` | `results[{title,url,snippet?}]` |
| `read` | 文本为字符串，图片为 `{type:"image",data,mimeType,note}`，PDF 为 `{type:"pdf",content}`，保留页标记和图片块 |

Bash 脚本输出不折叠重复行、不移除终端控制符，最多 1 MiB，超限保留头尾并标记截断。空输出为 `""`。非零退出、超时和取消通过结果字段说明，脚本应检查 `status` 和 `exit_code`。审批拒绝等没有结构化结果的失败，以及搜索工具失败，会拒绝调用 Promise。错误状态由工具直接返回 `isError`，不再由事后判错钩子补写。

文件搜索仍受原有扫描、选择和访问边界限制。结构化结果不暴露内部排序诊断或网页来源合并信息。其他工具沿用上游的文本返回方式。`read` 图片结果可直接交给 `image(photo)` 或支持图片的 `models.classify(model, {state, images:[photo], questions})`。PDF 分类需从 `content` 筛选图片块。不要用 `text()`、`console` 或顶层 `return` 输出图片 Base64。读取失败拒绝 Promise，访问边界、取消及图片处理仍走原读取链路。

`skill` 和 `subagent` 为 `model-only`。技能正文必须由模型直接接收，不能用脚本执行了加载来代表已经披露。

嵌套工具经过 SDK 参数校验、审批、执行和结果钩子。Bash 文件观察窗口在队列内的 `tool_call` / `tool_result` 边界建立和释放，被阻止的调用只释放资源、不采纳变化。现有文件写入锁保持不变，嵌套写入不使用依赖 assistant 预声明批次的 LSP 合并优化。

GUI 输入栏在普通模式统计模型工具声明。codemode 模式使用代码图标，统计全部脚本可调用工具与已启用的 `model-only` 工具，不计 codemode 自身。工具面板把非 `model-only` 工具归入 codemode。未勾选但仍可被脚本调用的工具也在其中展示并计数。关闭模式恢复平级列表并保留选择。脚本专用和延迟子工具显示可调用状态，不提供误导性的禁用复选框。

调用卡片按真实父子关系展示。codemode 执行中展开子调用，完成后自动收起，手动展开状态优先。脚本与输出给模型的内容分别折叠。父脚本和子调用各自显示状态，捕获子调用错误不会把已成功的父脚本标为失败。切换模式不重排历史调用。

GUI 保留正在执行的父工具下已完成的子调用，父工具完成或恢复会话后读取 SDK 的 `nestedCalls`。父脚本和已完成子调用的摘要显示 SDK 耗时，恢复会话后仍可查看。普通工具结果采用 `execute()` 耗时。子调用执行中采用结束事件的 `durationMs`，父调用完成后采用 SDK 持久化的 `nestedCalls`。Pi 1.1.0 的后者还包含子调用排队与审批等待，因此不应与遥测执行耗时混作同一指标。该记录有上游大小限制，不包含结果正文，不完整时界面明确标注。

GUI 另将成功的 `write` 和 `edit` 子调用的实际 diff 保存为会话中的界面专用 custom 条目，不进入模型上下文。子调用展开后复用普通工具的 diff 组件，支持执行中查看、刷新和重新打开会话，大 diff 按需读取。旧会话没有保存 diff 时明确提示，不从参数或当前文件重建历史变更。脚本输出仍单独展示。

遥测记录 `parent_call_id`，不把子调用伪造成 assistant 批次。费用只读取 SDK 已汇总的父结果，不重复累计子调用。

QuickJS 只限制脚本环境，不隔离宿主工具的文件、进程或网络权限。现有 Approval Gate 只管理其明确支持的工具，不新增 MCP 或 `models.*` 审批。`models.*` 直接调用会话模型运行时，不经过嵌套工具审批。分类和图片生成的费用由 SDK 归入 codemode 结果。

## 打包

Bun 产物内嵌 QuickJS WASM，并按上游约定嵌入 codemode worker。Desktop 包含独立 worker 和 WASM 文件，worker 在安装包中解包。资源目录必须先于 Pi 配置模块初始化，避免版本和默认路径在加载时取错值。

## 效率验证

`tests/cli/cli.test.ts` 使用本地模拟模型，通过真实独立二进制比较同一组“搜索 51 个候选后读取目标文件”任务。固定脚本不能代表真实模型编写脚本的成功率。

Pi 1.1.0 下，固定 `read/find/bash/codemode` 工具集合，使用原生提示词、开放 `models` 并声明 `read` 结构化图片/PDF 返回后，实际请求中的 codemode 定义估算为 906 tokens。此处统计包含工具返回类型，不是只统计上游提示词。

搜索读取场景样本：

| 指标 | 直接调用 | Codemode |
| --- | ---: | ---: |
| 模型请求数 | 3 | 2 |
| 最终请求中的工具结果估算 token | 362 | 60 |
| 全部请求 JSON 累计估算 token | 2552 | 2169 |

估算使用仓库本地计数器，不是提供方实际计费，不计算缓存折扣。请求中的临时路径等会导致小幅波动，固定场景不能证明所有任务都更省 tokens。本轮未做真实模型对比。codemode 仍按需开启，开启后固定使用 `only`，不降低默认目录或输出预算。`/stats` 的工具定义拆分仍是注册定义估算，不能用它验证 `prepareLoadout` 后的实际声明成本，应比较真实请求。

日常验证命令：

```bash
bun run typecheck
bun run build:tui
bun run vitest run tests/cli/cli.test.ts tests/cli/codemode-mcp.test.ts -t codemode --silent=false
```

仅在需要验证真实浏览器交互时，运行定向无头 E2E：

```bash
bun run test:gui tests/gui/codemode.e2e.ts --project=desktop
```

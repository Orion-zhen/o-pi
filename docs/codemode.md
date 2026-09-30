# Codemode

复用 Pi 的 `codemode` 和 `tool_search`，不维护脚本调度器。TUI、无界面子进程、Web 和 Desktop 共用固定为 `only` 模式的 codemode 内置工厂。默认不启用。

## 启用

在 `~/.pi/agent/settings.json` 中增补：

```json
{
  "defaultTools": ["+codemode"]
}
```

单次 CLI 调用使用 `--tools read,find,grep,bash,codemode`。`--tools` 优先于 `defaultTools`，替换整个集合。当前分支的手动选择优先。`extensions: ["-builtin:codemode"]` 可禁用内置扩展。

opi 中启用 codemode 即使用 `only` 模式，忽略设置中的 `codemode.mode`，不提供原生 `on` 模式。所有非 `model-only` 工具不再单独向模型声明，包括已激活的脚本专用和延迟工具。其调用契约由 codemode 提供。`model-only` 工具仍直接向模型声明，但隐藏重复的 `tool_search` 入口，发现工具统一使用脚本内的 `searchTools()`。关闭 codemode 后恢复普通工具声明，不改变其他工具的选择状态。

不要把 `/tools` 的未勾选理解为权限拒绝，`codemode`、`deferred` 曝光的工具仍可被脚本调用。

## 模型可见接口

codemode 复用上游执行器，通过公开扩展工厂替换工具描述和 `prepareLoadout`。保持原参数 schema、审批、取消、会话存储和结果格式，不修改上游生成的长字符串。

- 关闭 `models` API，不提供模型目录或分类器调用。
- `description` 保留调用、输出、错误、副作用、存储和资源限制，并动态附加子工具目录。
- `promptGuidelines` 提供同一脚本内完成已知调用链、过滤汇总和最小输出策略，仅在 codemode 启用时由系统提示词统一收集到 `tool_policy`。通用并发与顺序规则不按工具名分支。
- `promptSnippet` 保留一行能力摘要，供 Pi 默认系统提示词使用，不在 opi 的自定义系统提示词中重复工具目录。
- 工具签名使用上游 schema 渲染器生成，保留参数说明和返回类型，不重复包裹每个工具的声明。
- 内联目录预算仍默认约 3000 tokens，可通过 `codemode.inlineBudget` 调整。按命名空间轮流选择短声明，`deferred` 工具不内联。
- 有未展示的可调用工具时才介绍 `searchTools()`，搜索结果包含签名。有 MCP 结果时才附加共享类型和图片转交说明。
- 主要介绍 `text()` 和顶层 `return`。`console.*`、`exit()`、`ALL_TOOLS`、`describeTool()` 等上游能力不删除，但不重复介绍。

## 普通模式的工具发现

`tool_search` 默认不启用，可通过 `defaultTools` 或 `--tools` 启用。它搜索尚未激活的 `codemode` 和 `deferred` 工具，默认最多加载 3 个，`limit` 可指定正整数上限。查询精确匹配候选工具名时，只加载该工具，否则复用上游 BM25。查询使用工具名或英文关键词，上游分词不支持纯中文查询。

没有可搜索工具时，`tool_search` 自动关闭，工具选择器中不可启用。候选工具全部加载或隐藏后同样关闭。出现新的候选工具后恢复可选，但不自动启用。

结果仅返回 `Loaded: name, ...` 或 `No matches.`，完整契约由下一次请求的工具声明提供。已加载工具的激活状态沿用 SDK 的会话分支记录，不自动卸载。常驻描述只保留使用语义和来源目录，每个来源保留描述首行。

codemode 下隐藏 `tool_search` 声明，不改变它的选择状态，关闭 codemode 后恢复。`searchTools()` 保留上游行为，默认返回最多 8 个含签名的结果，不改变工具激活状态，需要用 `text()` 或顶层 `return` 输出给模型。

## 结果与边界

模型直接调用时继续接收紧凑 `content`，脚本通过 `outputSchema` 接收最小 `structuredContent`：

| 工具 | 脚本结果 |
| --- | --- |
| `bash` | `output`、`status`、`exit_code`、`wall_time_seconds`、`truncated`、`capture_complete`，以及保留日志时的 `full_output_path` |
| `find` | `matches[{path,kind}]`、`total_matches`、`truncated`，以及部分失败时的 `scope_errors` |
| `grep` | `regions[{path,start_line,end_line,symbol?,lines}]`、`truncated`，以及部分失败时的 `scope_errors` |
| `websearch` | `results[{title,url,snippet?}]` |

Bash 脚本输出不折叠重复行、不移除终端控制符，最多 1 MiB，超限保留头尾并标记截断。空输出为 `""`。非零退出、超时和取消通过结果字段说明，脚本应检查 `status` 和 `exit_code`。审批拒绝等没有结构化结果的失败，以及搜索工具失败，会拒绝调用 Promise。错误状态由工具直接返回 `isError`，不再由事后判错钩子补写。

文件搜索仍受原有扫描、选择和访问边界限制。结构化结果不暴露内部排序诊断或网页来源合并信息。其他工具沿用上游的文本返回方式，不保证 `read` 的图片可通过脚本自动转交给模型。

`skill` 和 `subagent` 为 `model-only`。技能正文必须由模型直接接收，不能用脚本执行了加载来代表已经披露。

嵌套工具经过 SDK 参数校验、审批、执行和结果钩子。Bash 文件观察窗口在队列内的 `tool_call` / `tool_result` 边界建立和释放，被阻止的调用只释放资源、不采纳变化。现有文件写入锁保持不变，嵌套写入不使用依赖 assistant 预声明批次的 LSP 合并优化。

GUI 输入栏在普通模式统计模型工具声明。codemode 模式使用代码图标，统计全部脚本可调用工具与已启用的 `model-only` 工具，不计 codemode 自身。工具面板把非 `model-only` 工具归入 codemode。未勾选但仍可被脚本调用的工具也在其中展示并计数。关闭模式恢复平级列表并保留选择。脚本专用和延迟子工具显示可调用状态，不提供误导性的禁用复选框。

调用卡片按真实父子关系展示。codemode 执行中展开子调用，完成后自动收起，手动展开状态优先。脚本与输出给模型的内容分别折叠。父脚本和子调用各自显示状态，捕获子调用错误不会把已成功的父脚本标为失败。切换模式不重排历史调用。

GUI 保留正在执行的父工具下已完成的子调用，父工具完成或恢复会话后读取 SDK 的 `nestedCalls`。该记录有上游大小限制，不包含结果正文，不完整时界面明确标注。

GUI 另将成功的 `write` 和 `edit` 子调用的实际 diff 保存为会话中的界面专用 custom 条目，不进入模型上下文。子调用展开后复用普通工具的 diff 组件，支持执行中查看、刷新和重新打开会话，大 diff 按需读取。旧会话没有保存 diff 时明确提示，不从参数或当前文件重建历史变更。脚本输出仍单独展示。

遥测记录 `parent_call_id`，不把子调用伪造成 assistant 批次。费用只读取 SDK 已汇总的父结果，不重复累计子调用。

QuickJS 只限制脚本环境，不隔离宿主工具的文件、进程或网络权限。本轮没有为 MCP 增加审批策略，现有 Approval Gate 只管理其明确支持的工具。

## 打包

Bun 产物内嵌 QuickJS WASM，并按上游约定嵌入 codemode worker。Desktop 包含独立 worker 和 WASM 文件，worker 在安装包中解包。资源目录必须先于 Pi 配置模块初始化，避免版本和默认路径在加载时取错值。

## 效率验证

`tests/cli/cli.test.ts` 使用本地模拟模型，通过真实独立二进制比较同一组“搜索 51 个候选后读取目标文件”任务。固定脚本不能代表真实模型编写脚本的成功率。

Pi 0.99.1 下，固定 `read/find/bash/codemode` 工具集合，实际请求中的 codemode 定义在精简前后分别估算为 1812 和 614 tokens。两者均使用 `only` 模式，减少约 66%。

精简后的搜索读取场景样本：

| 指标 | 直接调用 | Codemode |
| --- | ---: | ---: |
| 模型请求数 | 3 | 2 |
| 最终请求中的工具结果估算 token | 362 | 60 |
| 全部请求 JSON 累计估算 token | 2558 | 1605 |

估算使用仓库本地计数器，不是提供方实际计费，不计算缓存折扣。请求中的临时路径等会导致小幅波动，固定场景不能证明所有任务都更省 tokens。本轮未做真实模型对比。codemode 仍按需开启，开启后固定使用 `only`，不降低默认目录或输出预算。`/stats` 的工具定义拆分仍是注册定义估算，不能用它验证 `prepareLoadout` 后的实际声明成本，应比较真实请求。

验证命令：

```bash
bun run typecheck
bun run build:tui
bun run vitest run tests/cli/cli.test.ts tests/cli/codemode-mcp.test.ts -t codemode --silent=false
bun scripts/build.mjs web desktop --dir
bun run playwright test --config playwright.gui.config.ts tests/gui/codemode.e2e.ts
```

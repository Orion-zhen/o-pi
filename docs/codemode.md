# Codemode

复用 Pi 的 `codemode` 和 `tool_search`，不维护脚本调度器。TUI 和无界面子进程由上游 CLI 加载，Web 与 Desktop 在 SDK 装配时显式注册内置工厂。默认不启用。

## 启用

在 `~/.pi/agent/settings.json` 中增补：

```json
{
  "defaultTools": ["+codemode"]
}
```

单次 CLI 调用使用 `--tools read,find,grep,bash,codemode`。`--tools` 替换整个集合。已有 `tools.jsonc` 的默认值和按模型规则仍覆盖初始集合，当前分支的手动选择优先。`extensions: ["-builtin:codemode"]` 可禁用内置扩展。

`codemode.mode` 默认 `on`，保留直接工具调用。`only` 会隐藏可由脚本调用的工具声明，但不会隐藏 `model-only` 工具。不要把 `/tools` 的未勾选理解为权限拒绝，`codemode`、`deferred` 曝光的工具仍可被脚本调用。

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

GUI 实时子调用归入父工具，完成或恢复会话后读取 SDK 的 `nestedCalls`。该记录有上游大小限制，不包含结果正文，不完整时界面明确标注。遥测记录 `parent_call_id`，不把子调用伪造成 assistant 批次。费用只读取 SDK 已汇总的父结果，不重复累计子调用。

QuickJS 只限制脚本环境，不隔离宿主工具的文件、进程或网络权限。本轮没有为 MCP 增加审批策略，现有 Approval Gate 只管理其明确支持的工具。

## 打包

Bun 产物内嵌 QuickJS WASM，并按上游约定嵌入 codemode worker。Desktop 包含独立 worker 和 WASM 文件，worker 在安装包中解包。资源目录必须先于 Pi 配置模块初始化，避免版本和默认路径在加载时取错值。

## 效率验证

`tests/cli/cli.test.ts` 使用本地模拟模型，通过真实独立二进制比较同一组“搜索 51 个候选后读取目标文件”任务。固定脚本不能代表真实模型编写脚本的成功率。

在 Pi 0.99.1、默认 `codemode.mode: on` 下的样本：

| 指标 | 直接调用 | Codemode |
| --- | ---: | ---: |
| 模型请求数 | 3 | 2 |
| 最终请求中的工具结果估算 token | 362 | 60 |
| 全部请求 JSON 累计估算 token | 2564 | 4745 |

估算使用仓库本地计数器，不是提供方实际计费，不计算缓存折扣。脚本描述增加了小任务的输入成本，不能据此宣称总 token 一定下降。因此保持按需开启，不自动设置 `only` 或修改 `inlineBudget`。`/stats` 的工具定义拆分仍是注册定义估算，不能用它验证 `prepareLoadout` 后的实际声明成本，应比较真实请求。

验证命令：

```bash
bun run typecheck
bun run build:tui
bun run vitest run tests/cli/cli.test.ts -t codemode --silent=false
bun scripts/build.mjs web desktop --dir
bun run playwright test --config playwright.gui.config.ts tests/gui/codemode.e2e.ts
```

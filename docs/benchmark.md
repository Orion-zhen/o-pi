# 性能基准

统一入口：

```bash
npm run bench
```

默认执行 7 次正式采样。`startup`、`agent-loop` 和 `lazy` 各执行 2 次预热，专项套件使用各自的预热策略。默认范围包括 Pi 启动、模型工具回路、延迟加载组件，以及文件工具、文件搜索、代码索引和网页工具。

内置套件中的 Pi 启动和模型发现都使用离线模式。模型工具回路使用本地模拟模型，网页工具套件使用注入的本地响应。这些内置基准不访问真实模型或公网。

快速冒烟：

```bash
npm run bench -- --quick
```

`--quick` 把正式采样设为 3 次，并把 `startup`、`agent-loop` 和 `lazy` 的预热设为 1 次。专项套件仍使用各自的预热策略。

## 基准套件

| 套件 | 内容 |
| --- | --- |
| `startup` | 比较 Pi 核心、Pi 资源和全部扩展三种场景的非交互启动与 TUI 启动。全部扩展场景还汇总 Pi 内部主流程计时，以及每个扩展的 `module import` 和 `factory` 计时。 |
| `agent-loop` | 启动真实的 `pi --print` 进程。本地 OpenAI-compatible 模拟模型依次触发两次 `ls`、两次 `find` 和两次 `grep`，并测量首次模型请求、每次工具回路和退出耗时。 |
| `lazy` | 测量分词器模块导入、o200k 和 cl100k 的首次与后续计数，以及数学 Markdown 解析器、MathJax/Resvg、字体预热、首次渲染和缓存渲染。 |
| `file-tools` | 测量裸 Pi 与文件工具扩展的非交互启动、TUI 就绪、扩展导入与注册，以及注册后的首次 `ls`。 |
| `file-search` | 测量首次与后续 `find`、带模拟文件系统延迟的 `find`、首次与后续 `grep`、并发 `grep` 和宽范围 `grep`。 |
| `code-index` | 使用生成的 TypeScript 内容测量首次与后续解析、本地并行批处理、工作线程批处理和内存占用。场景包括 ASCII、Unicode、密集声明、长行和大量导入。 |
| `web-tools` | 测量裸 Pi 与网页工具扩展的启动、模拟 `websearch` 和 `webfetch`、跳过不支持的直接图片、DuckDuckGo 解析器，以及多种大型 HTML 场景的转换。 |

选择套件：

```bash
npm run bench -- --suites=startup,agent-loop,lazy
```

`code-index` 的批处理使用两个 `.ts` 文件和两个 `.tsx` 文件，四项都进入真实解析，不混入未注册的扩展名。输出摘要覆盖代码单元内容与范围、导入模块名及路径语义，不包含已删除的导入坐标。`counts` 报告首次、后续及两种批处理的解析状态，`completeRuns` 表示所有文件都完成解析的正式采样数。大样本可能触发固定解析截止时间，不完整采样的耗时不能作为完整解析的性能结论。

`scripts/benchmark/registry.mjs` 负责注册统一入口中的套件。运行逻辑和统计逻辑分别位于 `scripts/benchmark/runtime.mjs` 和 `scripts/benchmark/stats.mjs`。专项脚本只编排场景，独立进程使用的工作脚本集中在 `scripts/workers/`。

可以通过 `--plugin` 加载外部套件。模块应通过 `default`、`suite` 或 `suites` 导出 `{ id, execute }` 对象或对象数组：

```bash
npm run bench -- --plugin=./scripts/my-benchmark.mjs --suites=my-benchmark
```

`--plugin` 可以重复指定。套件 ID 不得与已有套件重复。

可用参数：

```text
--quick                 3 次正式采样。startup、agent-loop 和 lazy 预热 1 次
--runs=N                正式采样次数，默认 7
--warmups=N             startup、agent-loop 和 lazy 的预热次数，非 quick 模式默认为 min(2, runs)
--suites=LIST           逗号分隔的套件 ID，或 all
--json=PATH             保存环境、选项和套件返回的结构化结果
--plugin=PATH           加载外部套件模块，可以重复指定
--help                  显示帮助
```

`--json` 只记录返回结构化结果的套件。`file-tools`、`file-search`、`code-index` 和 `web-tools` 由独立脚本输出表格，不会把表格数据写入统一 JSON 文件。

统一入口中的 `file-tools`、`file-search`、`code-index` 和 `web-tools` 至少需要 3 次正式采样。`file-search` 的相邻 `grep` 调用复用同一进程内的正文缓存。`grep_content_cache_bytes` 和 `grep_content_cache_entries` 分别限制缓存总字节数和文件数。任一字段设为 `0` 都会禁用正文缓存，可用于测量无缓存基线。

## 排序基准

多通道排序的独立 CPU 基准不属于统一套件。运行命令：

```bash
npm run bench:file-tools:ranking -- --runs=15
```

该基准使用 1,000、5,000 和 20,000 个合成候选，测量以下操作：

- `find` 实际使用的流式 fzf Top-50 排名。
- `grep` 的字段排序，以及排序后选择 Top-32 结果。

基准还验证 `find` 排序不依赖输入顺序，有限容量与保留全部候选时具有相同的前 50 项，并验证 `grep` 的固定层级边界和稳定顺序。排序场景不扫描项目文件，也不调用 LSP 后端。

## 启动场景

`startup` 会轮换每轮中的场景执行顺序，用于减小 CPU 温度、即时编译和后台负载造成的顺序偏差：

- `Pi core`：禁用扩展、技能、提示词模板、主题和上下文文件。
- `Pi + resources`：只禁用扩展，用于估算资源发现开销。
- `Pi + all extensions`：加载本仓库的完整配置。

非交互场景使用 `--list-models`，测量模块发现、导入和注册，直到进程退出。TUI 场景使用伪终端，并在 Pi 输出完整的主流程和扩展计时表后停止。如果系统没有 `/usr/bin/script`，统一入口会跳过 TUI 启动测量。

Pi 在进入交互模式的运行循环前输出这些计时表。因此，数学渲染预热和模型自动刷新等后续任务不会计入该启动时点。

设置 `PI_TIMING=1` 后可以获得 Pi 内部计时：

- 主流程计时展示运行时和会话创建等阶段。
- 扩展计时分别记录每个扩展的 `module import` 和 `factory`。

外部墙钟时间还包括 Node.js 进程启动、Pi 命令行入口、伪终端和基准观测开销，因此其范围大于 Pi 内部计时。

## 模型工具回路

`agent-loop` 会创建临时提供方扩展和本地 HTTP 服务器。模拟模型通过 OpenAI Chat Completions SSE 立即返回以下调用：

1. 连续调用两次 `ls`，路径为 `scripts`。
2. 连续调用两次 `find`，参数为 `query=bench`、`path=scripts` 和 `glob=*.mjs`。
3. 连续调用两次 `grep`，在 `scripts/*.mjs` 中搜索 `runAgentLoopSuite`。
4. 收到第六个工具结果后返回 `done`。

这条链路经过 Pi 命令行入口、提示词构建、模型协议适配、工具定义、工具执行、工具结果回填和进程清理。基准不包含公网延迟或真实模型推理时间。

该回路只调用本仓库文件工具扩展注册的替换工具，不调用 Pi 内置的 `ls`、`find` 或 `grep`。每种工具的两次相邻调用分别表示首次调用和同一进程内的后续调用。固定顺序为 `ls → find → grep`，因此结果表示真实连续代理回路中的增量耗时，不是彼此隔离的工具耗时。

## 统计与对比

统计使用最近秩方法计算 P50 和 P95。常规表格显示 P50、P95 和最小值，启动、模型工具回路和延迟加载组件等汇总表还显示最大值。启动总表同时显示相对 `Pi core` 的增量。

大多数套件为每次正式采样启动新进程，因此结果主要反映进程冷启动且文件系统已预热的情况。`code-index` 使用进程内生成的内容，不依赖文件系统夹具。独立排序基准在同一进程中重复执行 CPU 操作。

建议在机器负载和依赖版本相同的条件下保存修改前后的结果：

```bash
npm run bench -- --runs=9 --suites=startup,agent-loop,lazy --json=bench-before.json
# 修改后再次运行，输出到 bench-after.json
```

不要直接比较运行环境、依赖版本或场景不同的结果。少于 7 次采样时，P95 只适合冒烟检查，不适合作为性能回归结论。

各专项脚本使用以下默认预热次数：

- `file-tools` 和 `web-tools` 预热 2 次。
- `file-search` 和 `code-index` 预热 1 次。
- 独立排序基准固定预热 3 次。

CPU 调频、杀毒或索引任务、首次磁盘读取，以及 Node.js 或 Pi 依赖升级都可能显著影响结果。

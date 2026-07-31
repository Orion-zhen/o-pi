# 性能 Benchmark

统一入口：

```bash
npm run bench
```

默认执行 2 次预热和 7 次正式采样，覆盖 Pi 启动、扩展分项、模型工具回路、延迟组件，以及 file-tools、file-search、code-index、web-tools 的专项 benchmark。所有启动与模型发现均使用 offline 模式；模型工具回路和 Web benchmark 使用本地假服务，不访问真实模型或公网。

快速冒烟：

```bash
npm run bench -- --quick
```

## Suite

| Suite | 内容 |
| --- | --- |
| `startup` | 对比 Pi core、resources、完整 extensions 的非交互启动和交互 startup-ready；聚合 Pi 内部 main timing，以及每个扩展的 module import/factory。 |
| `agent-loop` | 启动真实 `pi --print`，本地 OpenAI-compatible 假模型依次触发 `ls`、`find`、`grep`，每种连续调用两次；拆分首个模型请求、每种工具的 cold/warm 回路和退出耗时。 |
| `lazy` | 分别测量 tokenizer 模块导入、首次/后续 o200k/cl100k 计数，以及数学 Markdown parser、MathJax/Resvg 导入、字体预热、首次/缓存渲染。 |
| `file-tools` | 裸 Pi/扩展启动、TUI ready、扩展注册和首次 `ls`。 |
| `file-search` | cold/warm `find`、cold/warm `grep` 和并发 `grep`。 |
| `web-tools` | 裸 Pi/扩展启动、fake websearch/webfetch cold/warm、DDG parser cold/warm。 |

选择 suite：

```bash
npm run bench -- --suites=startup,agent-loop,lazy
```

统一入口通过 `scripts/benchmark/registry.mjs` 注册 suite；运行时和统计逻辑分别集中在
`scripts/benchmark/runtime.mjs` 与 `scripts/benchmark/stats.mjs`，专项入口只保留场景编排。
所有独立进程 worker 集中在 `scripts/workers/`，同一领域的不同模式通过参数复用 worker。
也可以加载外部 suite（模块导出一个 `{ id, execute }`，或 suite 数组）：

```bash
npm run bench -- --plugin=./scripts/my-benchmark.mjs --suites=my-benchmark
```

可用参数：

```text
--quick                 3 次正式采样、1 次预热
--runs=N                正式采样次数，默认 7
--warmups=N             统一 suite 的预热次数，默认 min(2, runs)
--suites=LIST           逗号分隔的 suite，或 all
--json=PATH             保存统一 suite 的结构化结果
--help                  显示帮助
```

`file-tools`、`file-search` 和 `web-tools` 的统计至少需要 3 次正式采样。`file-search` 的相邻 grep 调用复用进程内正文缓存；其总字节和文件数分别由 `grep_content_cache_bytes`、`grep_content_cache_entries` 配置，任一设为 `0` 可测量无缓存基线。

多通道排序的独立 CPU 基准不进入统一 suite，可直接运行：

```bash
npm run bench:file-tools:ranking -- --runs=15
```

该基准覆盖 `find` 在 1k/5k/20k 候选上的完整 fzf path 排名、稳定顺序和有界 Top-50 前缀，以及 `grep` 的字段排序、证据融合与多样性 Top-K；使用合成候选，不访问文件系统或 LSP 后端。

## 启动场景

统一启动 benchmark 轮换场景执行顺序，降低 CPU 温度、JIT 和后台负载造成的顺序偏差：

* `Pi core`：禁用 extensions、skills、prompt templates、themes 和 context files。
* `Pi + resources`：只禁用 extensions，用于估算资源发现开销。
* `Pi + all extensions`：加载本仓库完整配置。

非交互启动使用 `--list-models`，测量模块发现、导入和注册后进程退出。交互启动使用伪终端，在 Pi 输出完整 main/extension timing 表后停止；该时点位于 idle 初始化之前，因此数学渲染、模型自动刷新等延迟任务不会混入启动结果。

Pi 内部分项来自 `PI_TIMING=1`：

* main timing 展示 runtime/session 创建阶段。
* extension timing 分开统计每个扩展的 `module import` 和 `factory`。
* 外部 wall time 还包含 Node 进程启动、Pi CLI/bootstrap 和 benchmark 观测成本，所以会大于内部 TOTAL。

## 模型工具回路

`agent-loop` 会创建临时 provider extension 和本地 HTTP server。假模型立即返回 OpenAI Chat Completions SSE：

1. 连续调用两次 `ls scripts`。
2. 连续调用两次 `find`，使用 `query=bench`、`path=scripts`、`glob=*.mjs`。
3. 连续调用两次 `grep runAgentLoopSuite in scripts/*.mjs`。
4. 收到第六个工具结果后返回 `done`。

这条链路实际经过 Pi CLI、prompt 构建、模型协议适配、tool schema、工具执行、tool result 回填和进程清理，但不包含公网延迟与模型生成时间。工具回路仅调用本仓库 file-tools 注册的替换版工具，不执行 Pi 内建 `ls`、`find` 或 `grep`。每种工具的相邻两次调用用于区分首次 lazy import/cold cache 和同进程 warm 调用。固定顺序为 `ls → find → grep`，因此数据表示真实连续 agent 回路中的增量开销。

## 统计与对比

表格统一展示 process-cold/filesystem-warm 的 P50、P95、min，关键总表还展示 max 和相对 Pi core 增量。推荐在相同机器负载和依赖版本下保存前后结果：

```bash
npm run bench -- --runs=9 --suites=startup,agent-loop,lazy --json=bench-before.json
# 修改后再次运行，输出到 bench-after.json
```

不要把不同模型或真实网络请求的数据直接比较。少于 7 次的 P95 只能用于冒烟，不适合作为回归结论。专项入口保留各自的采样策略：file-tools/web 默认 2 次预热，file-search 默认 1 次预热，ranking 固定 3 次预热。CPU 调频、杀毒/索引任务、首次磁盘读取和 Node/Pi 依赖升级也会显著影响结果。

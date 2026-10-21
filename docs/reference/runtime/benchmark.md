# 性能基准

```bash
bun run bench
bun run bench --quick
bun run bench --suites=startup,agent-loop,lazy
```

入口先构建 TUI，默认运行本地 opi，可用 PI_BIN 指定其他入口。默认采样 7 次，quick 为 3 次。startup、agent-loop 和 lazy 默认预热 2 次，quick 预热 1 次。

## 套件

| 套件 | 测量 |
| --- | --- |
| startup | Pi 核心、资源和完整扩展的启动 |
| agent-loop | 真实进程中的首次请求与文件工具回路 |
| lazy | 分词器、数学解析、渲染与缓存 |
| file-tools | 模块导入、注册和首次 ls |
| file-search | 首次、后续、并发和宽范围搜索 |
| code-index | 语法解析、批处理、worker 和内存 |
| web-tools | 注册、调用、HTML 转换和内存 |

内置基准使用离线发现、本地模型服务和模拟网页响应。file-tools 与 web-tools 预热 2 次，file-search 与 code-index 预热 1 次，专项套件至少采样 3 次。

## 参数

```text
--quick
--runs=N
--warmups=N
--suites=LIST
--json=PATH
--plugin=PATH
--help
```

warmups 控制 startup、agent-loop 和 lazy，默认 min(2, runs)。JSON 只保存返回结构化结果的套件，专项脚本表格由各进程输出。

外部套件通过 default、suite 或 suites 导出 `{ id, execute }` 或其数组，ID 需唯一。

## 启动

startup 轮换场景顺序，比较：

- Pi core：禁用扩展与其他资源。
- Pi + resources：只禁用扩展。
- Pi + all extensions：本仓库完整配置。

非交互场景使用 `--list-models`，TUI 使用伪终端并等待启动计时表。缺少 `/usr/bin/script` 时跳过 TUI 场景。`PI_TIMING=1` 可输出 Pi 内部计时。

进程墙钟时间包含运行时和观测开销，内部计时按启动阶段统计。

## 工具回路

agent-loop 创建临时模型配置与本地 HTTP 服务，连续执行两次 ls、两次 find 和两次 grep，再返回 done。流程覆盖提示词、模型协议、工具执行、结果回填和退出。

同种工具的两次调用分别表示首次与后续调用，顺序固定，因此测量的是连续代理回路中的增量耗时。

## 排序

```bash
bun scripts/bench-file-tools-ranking.mjs --runs=15
```

独立 CPU 基准使用 1000、5000 和 20000 个候选，测量 find 的有界 fzf Top-50 与 grep 的排序、Top-32 选择。默认预热 3 次，同时验证稳定性和层级边界。

## 比较

统计采用最近秩 P50、P95，并记录最小值，汇总表还可包含最大值。多数套件每次采样启动新进程，文件系统已预热。

```bash
bun run bench --runs=9 --suites=startup,agent-loop,lazy --json=bench-before.json
```

修改后在相同负载、依赖版本和场景下输出另一份结果。少于 7 次采样的 P95 用于冒烟检查。CPU 调频、索引任务和依赖升级会影响结果。

实现入口为 `scripts/benchmark/registry.mjs`、`runtime.mjs` 和 `stats.mjs`，专项进程位于 `scripts/workers/`。

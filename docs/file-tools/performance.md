# 性能与 benchmark

本文说明文件工具的 lazy loading、cache、取消和阶段 13 测量结果。完整 benchmark suite、采样规则和统计方法见 [性能 Benchmark](../benchmark.md)。

## Lazy loading

扩展注册阶段只加载 Pi schema、guards、telemetry 和 lazy controller，不加载 filesystem host、任一 command、native renderer、Tree-sitter grammar、LSP 或 Repo Map runtime。

- 六个 adapter 分别使用 retryable dynamic import；同模块并发调用共享 Promise，失败后可重试；
- host 在第一个文件工具 invocation 才加载；
- first `ls` 加载 ls command 与 readonly filesystem data plane，但不加载 find/grep、mutation service、媒体处理、Tree-sitter、LSP 或 Repo Map；
- filesystem mutation service 与进程内 queue 在第一次 write/edit 时动态加载；
- find suggestion worker 与 grep index/parser/worker 只由各自 tool instance 创建；
- 图片转换只在 read 图片路径加载，structure/LSP 只在 partial/truncated read 路径加载；
- Repo Map 只有 session 激活后首次 query/mutation 才加载完整 runtime；
- TUI renderer 只在 TUI `session_start` 加载，RPC 不加载。

shutdown 只 dispose 已加载的 tool/enhancement；清理本身不会触发 dynamic import。

## Cache 与 owner

| 状态 | key / freshness | owner |
| --- | --- | --- |
| config | user/project path 与 metadata fingerprint；按 invocation cwd | `FileToolsConfigProvider` |
| visibility snapshot | canonical workspace、policy/config/ignore fingerprint、tracked set | `FileSystemRuntime` |
| session observation | canonical file identity 与 content hash/size | `FileToolsHost` session |
| find suggestion worker | tool instance | `FindTool` |
| grep file index | workspace identity、visibility fingerprint、metadata/content hash、query filter/limits | `GrepTool` |
| grep in-flight build/parser/worker | consumer count 与 tool owner signal | `GrepTool` |
| LSP / Repo Map | subsystem-native generation/freshness | extension-owned lazy instance |

filesystem 只缓存事实和 visibility；find ranking 与 grep derived index 不进入 filesystem。grep cache 不永久保存完整源码，复用 entry 前仍执行当前 scope、visibility 和 live metadata/content gate。新增、修改、删除、配置或 ignore 变化会在后续 invocation 进入新 snapshot/fingerprint。

## 并发与取消

文件 I/O 使用 bounded concurrency，避免目录批次与内容读取形成乘法并发。traversal/line stream 在 break、abort 和 error 时释放 iterator/handle。

相同 grep build 的并发消费者共享工作；单个消费者取消只 detach，最后消费者退出才 abort build。find/grep owner dispose 会取消自身 pending worker/parser，但不会跨工具清 cache。

mutation 按 canonical target 在同进程串行，不同 target 可并行。取消在等待 queue 和提交前生效；提交后 observation 已更新，LSP/Repo Map port 失败或取消不能回滚。

## Benchmark 入口

```bash
npm run bench:file-tools                 # Pi startup、registration、first ls
npm run bench:file-tools:search          # find/grep 冷热路径、并发 grep
npm run bench:file-tools:ranking         # synthetic fusion、sort、Top-K/MMR
npm run bench:file-tools:calibration     # 当前工作树 Repo Map 相关性
```

前三个命令支持 `-- --runs=N`；默认 startup/search 为 7 次，ranking 为 15 次。worker 使用最终 `FileToolsHost`、`FindTool`、`GrepTool` 入口，并显式 dispose invocation、tool 与 host，不依赖旧 free function 或全局 cache-clear API。

## 阶段 13 测量

测量日期 2026-07-26，Node 22.23.1，Linux，同一 checkout 所在主机，process-cold/filesystem-warm。基线为阶段 1 提交 `a850383` 的独立 worktree；表格均为 p50。

### Startup 与 first ls

| metric | 阶段 1 | 最终 | 变化 |
| --- | ---: | ---: | ---: |
| file-tools ready delta | 90.8 ms | 90.4 ms | -0.4% |
| file-tools startup delta | 100.6 ms | 88.9 ms | -11.6% |
| Jiti import + register | 541.4 ms | 529.5 ms | -2.2% |
| first ls after register | 85.9 ms | 186.8 ms | +117.5% |

registration/startup 未回归。first ls 超过 15% 后进行了 import-path 调查：新增成本来自首次创建统一 namespace/access、visibility snapshot 和 capability services，不是 find/grep/LSP/Repo Map/Tree-sitter 或 renderer 预热。调查发现 readonly 调用还静态加载 mutation service/queue；阶段 13 已改为 first write/edit 才加载，使 first-ls p50 从修改前的 204.4 ms 降至 186.8 ms。剩余差异是安全 kernel 与 snapshot 初始化成本，未通过把重模块移回 registration 隐藏。

### Search

| metric | 阶段 1 | 最终 | 变化 |
| --- | ---: | ---: | ---: |
| cold find | 121.4 ms | 201.1 ms | +65.7% |
| warm find | 26.5 ms | 74.1 ms | +179.6% |
| cold grep | 120.1 ms | 304.5 ms | +153.5% |
| warm grep | 23.4 ms | 200.0 ms | +754.7% |
| concurrent grep | 59.1 ms | 394.0 ms | +566.7% |

这些路径均超过调查阈值。当前工作树文件数约比阶段 1 fixture 多 23%，但主要差异来自重构后的实时安全/正确性 gate：每次 invocation 重新绑定 policy/visibility，find 通过统一 traversal 验证 entry，grep 重走 allowed-ref、visibility、metadata/content hash 与 query gate，不能直接把旧 derived index 当作当前结果。并发 grep 还保留“最后消费者取消”与实时 hydration。profile 显示 warm host open 已约 1 ms，主要时间在 traversal/live validation，而非 host 或 enhancement eager import；因此没有用跳过 blocked/visibility/hash 检查换取旧延迟。

### Ranking 与 calibration

synthetic ranking 额外重复三轮、每轮 15 次；以下取三轮 p50 的中位数。N=20,000 的主要结果：grep fusion/full-sort 18.87 → 19.71 ms，grep fusion+head/MMR 36.22 → 33.15 ms，find fusion/full-sort 5.88 → 5.63 ms，find fusion+head/MMR 9.20 → 9.20 ms；均无稳定超过 15% 的回归。单轮小于毫秒或 GC 敏感项可明显波动，因此不以一次 p50 判定算法回归。

最终 calibration 构建 606 files / 8963 symbols，`MRR=0.96`、`Recall@3=1`（14 cases），通过 0.95 threshold。阶段 1 calibration 脚本在当前依赖环境因旧 grep 单-path 调用返回 `path must contain at least one scope.`，无法生成可比较的历史质量值；该失败不影响最终脚本，最终脚本使用数组 scope 与新 command/host。

性能数据受 JIT、filesystem cache 和系统负载影响；回归判断以同主机 p50 与 import/profile 证据为准，不把 p95 噪声单独视为 eager-load 结论。

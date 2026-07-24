# Repo Map 性能与缓存

## 主要成本

Repo Map 的成本主要来自：

1. repository discovery 和文件扫描。
2. 文件身份和内容变化检测。
3. symbol、architecture、relationship 和 test indexer。
4. generation 序列化和提交。
5. 查询时的候选收集和上下文渲染。

## 首次构建与增量刷新

首次构建需要扫描并建立完整图。refresh 可以复用 previous file records，以及未变化文件的解析结果。

只有文件、Git revision、配置、ignore 和 parser fingerprint 都一致时，才会直接复用完整 generation。否则只复用仍然安全的局部结果。

## 并发

`scan.concurrency` 控制扫描和部分索引阶段的并发度。并发提高吞吐，但会增加磁盘竞争和内存使用。查询候选收集也有独立上限，不会为了输出少量上下文而无限扩张。

同一个 map 的 refresh 使用串行更新锁；不同 map 可以独立执行。

## Cache

每个 map 保留有限数量 generation。新 generation 成功提交后，旧 generation 按稳定规则清理。current pointer 始终指向完整提交的 generation。

缓存读取使用有限的进程内 reader cache，但 freshness 仍会检查磁盘 current pointer、Git revision、配置和 ignore fingerprint。

## 调优方向

优先调整：

- `scan.max_files`
- `scan.max_file_bytes`
- `scan.concurrency`
- `cache.max_generations`
- 输出 token budgets

不要通过提高 limits 来掩盖 ignore 配置过宽、生成了不必要的大量候选或 parser diagnostics。

## Benchmark

独立基准不依赖模型或网络：

```bash
npm run bench:repo-map
npm run bench:repo-map -- --runs=3 --sizes=100,1000,10000
```

基准使用临时目录中的确定性 fixture，覆盖扩展加载、inactive command、runtime import、首次构建、无变化刷新、单文件刷新、generation 冷/热读取、首次/重复查询、read context、mutation refresh 和进程内存。每轮结束会清理源码和缓存；同一规模的 generation 与 query oracle 不稳定时基准直接失败。

性能比较必须使用相同机器、fixture 和运行次数，并同时确认：

- semantic oracle 和图计数不变。
- inactive `status`/`off` 不扫描仓库。
- 首次构建和增量刷新没有明显回退。
- generation 重复读取、重复查询和 read context 的优化不改变结果。
- 大规模 fixture 的峰值内存保持在可接受范围。

Repo Map 的统一 benchmark 指标和其他工具基准见 [benchmark.md](../benchmark.md)。

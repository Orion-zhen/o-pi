# 性能与 benchmark

本文说明文件工具的跨工具性能策略。完整 benchmark suite、采样规则和统计方法见 [性能 Benchmark](../benchmark.md)。

## Lazy loading

扩展启动时只注册 schema、轻量 renderer 和事件，不加载文件遍历、媒体识别、Tree-sitter grammar、LSP runtime 或 Repo Map runtime。

各工具独立懒加载：

- 首次 `ls` 只加载目录枚举路径；
- 首次 `find` 只加载路径扫描和排序路径；
- 首次 `grep` 才加载搜索、parser 或实际启用的增强；
- `read` 首次读取图片或 partial range 时才加载对应能力；
- LSP 只在 symbol、outline 或 diagnostics hook 真正需要时加载；
- Repo Map 只有激活后首次 query 或 mutation 才加载完整 runtime。

同一模块的并发调用共享一个 loading Promise。加载失败后清除 Promise，后续调用可以重试。

## 并发、缓存和取消

文件 I/O 默认并发路数为逻辑核心数的一半，单核至少为 1；共享 limiter 防止目录批次和文件读取形成乘法并发。

`grep` 在进程内缓存 fingerprint、signature、token、筛选 miss 和关系 metadata，不永久保存完整源码。相同 query、scope 和 match mode 的并发索引构建共享结果；单个消费者取消不会中断仍有消费者的构建。

缓存 fingerprint 使用 size、mtime 和内容 hash。新增、修改、删除或 ignore 变化会在后续调用中更新。

解析 worker 根据 grammar 文件数、总字节数、最大文件和 worker 冷热状态动态选择本地或并行路径；worker 会响应取消，失败时在本进程回退。

## Benchmark 入口

启动和首次 `ls`：

```bash
npm run bench:file-tools
```

`find`、`grep` 冷/热查询和并发 grep：

```bash
npm run bench:file-tools:search
```

合成候选的排序融合、完整排序和 Top-K：

```bash
npm run bench:file-tools:ranking
```

Repo Map 相关的真实工作树校准：

```bash
npm run bench:file-tools:calibration
```

以上命令都支持 `-- --runs=N` 调整采样次数。排序 benchmark 的参考实现和人工相关性校准见 [排序选择](ranking-selection.md)。

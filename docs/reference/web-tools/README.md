# 网页工具

| 工具 | 用途 |
| --- | --- |
| [websearch](websearch.md) | 查询公开网页索引，返回标题、URL 和摘要 |
| [webfetch](webfetch.md) | 读取 HTTP(S) 静态响应、图片和 PDF |

默认配置见 [`web-tools.jsonc`](../../../agent/defaults/web-tools.jsonc)，用户覆盖为 `~/.pi/agent/configs/web-tools.jsonc`，可通过 `PI_WEB_TOOLS_CONFIG` 指定路径。字段由 [`web-tools.schema.json`](../../../agent/schemas/web-tools.schema.json) 校验。

搜索分组、引擎和条数见 [websearch](websearch.md)。代理、地址检查和 Cookie 见[网络配置](network.md)。

## 生命周期

注册阶段只加载工具定义。首次调用延迟创建对应能力，搜索与抓取分别加载提供方、内容转换和 Cookie 模块。同一网络配置共用安全调度器。

配置按文件指纹缓存，每次调用取得独立副本。变更在后续调用生效，已经开始的请求使用原配置。运行时加载失败后，下次调用可以重试。

`source`、JSON、XML 和纯文本采用轻量转换路径，HTML 正文读取才加载 DOM、Readability 和 Turndown。PDF 使用共享媒体模块。

## 结果

模型接收紧凑文本与原生图片块。结构化状态、提供方、范围、遗漏和诊断保存在 `details`。网页内容按不可信数据处理。

`webfetch` 的 `partial` 表示已检测到内容遗漏，`next` 表示尚有文本可续读。两者含义见 [webfetch](webfetch.md#结果与续读)。

## 测量

```bash
bun scripts/bench-web-tools.mjs --runs=7
```

基准覆盖模块加载、首次与后续调用、HTML 转换和内存，使用本地模拟响应。统一测量方法见[性能基准](../runtime/benchmark.md)。

实现位于 `src/harness/web-tools/`，工具入口为 `src/harness/extensions/web-tools.ts`。

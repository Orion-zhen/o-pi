# webfetch

```ts
webfetch({
  url: string,
  mode?: "readable" | "source" | "image",
  pages?: string,
  find?: string,
  offset?: number,
})
```

## 模式

| 模式 | 返回内容 |
| --- | --- |
| `readable` | HTML 正文转 Markdown，其他文本按类型解码，PDF 提取文本 |
| `source` | 解码后的响应源码文本 |
| `image` | 图片直链、网页主图或 PDF 页面图片 |

`image` 不接受 `find` 和 `offset`。网页读取范围是静态响应，JavaScript 生成和交互后加载的内容可能缺失。

## 结果与续读

```xml
<webfetch kind="article" next="4200">
Page content.
</webfetch>
```

`offset` 从 0 开始，按转换后文本的 UTF-16 位置切片。字符预算来自 `webfetch.limits.default_output_chars`。继续读取时保留 URL、模式、页范围和查找词，并把 `next` 原样传回 `offset`。

`partial` 表示静态响应中检测到的遗漏，例如 iframe、客户端空壳、未解析声明、主图失败或视频本体。文本续读用 `next` 表示，与内容遗漏分开。使用结果时应说明实际取得的范围。

`details` 包含 `scope: "static_response"`、页面类型、正文来源、范围和遗漏。只在发生跳转时显示不同的最终 URL。

## 页内查找

```ts
webfetch({ url: "https://example.com/docs#authentication", find: "token" })
```

`find` 是 1–512 字符的字面子串，忽略大小写。readable 搜索提取后的文本，source 搜索源码，PDF 搜索文本层。HTML 锚点和 PDF 页范围先限定选区。

每个片段标记 `[start-end]`，左闭右开，使用 UTF-16 坐标。`matches` 是本次返回片段的命中数。`next` 指向下一处未完整返回的命中，保留相同 `find` 继续查询。

`find_max_passages` 默认 8。邻近命中合并，片段共享输出预算。需要扩读某个片段时去掉 `find`，将片段起点作为 `offset`。

## HTML 锚点

`readable` 和 `image` 支持 URL fragment，按静态 HTML 的 `id` 或 `<a name>` 定位。

标题选区包含子章节，直到下一个同级或更高层级标题。其他元素读取自身子树。正文清理和链接绝对化仍生效。找不到目标时返回 `ANCHOR_NOT_FOUND`，可去掉 fragment 读取整页。

## PDF

PDF 按 MIME 或文件签名识别。`pages` 使用从 1 开始的物理页码，支持 `N`、`N-M`、`N-` 和逗号组合。默认选择全部页，范围先排序合并，再应用处理上限。

- 文本模式每次最多 500 页、500 万 UTF-16 字符。
- 图片模式每次最多 20 页，后续范围通过 `next_pages` 返回。
- 渲染最长边为 2000 像素，SDK 再按模型图片配置处理。
- 文本结果带 `[page N]`，无文本层时可改用图片模式。
- 加密和损坏文档返回解析错误。

```ts
webfetch({ url: "https://example.com/report.pdf", pages: "12-14" })
webfetch({ url: "https://example.com/report.pdf", mode: "image", pages: "13" })
```

## 图片

`webfetch.media.mode` 控制图片输出：

| 值 | 行为 |
| --- | --- |
| `auto` | 默认值，显式 image 模式返回图片 |
| `on` | 普通 readable 也可返回图片直链和网页主图 |
| `off` | 关闭图片输出 |

显式图片请求要求模型支持图片。网页最多选择一张主图，来源包括正文、poster、Open Graph、Twitter Card 和 JSON-LD。实际类型按响应字节识别，下载遵循相同网络与 Cookie 检查。

视频和音频页面返回静态文字及可能存在的主图，并标记媒体本体遗漏。

## 提取与缓存

HTML 提取结合语义节点、Readability、JSON-LD 和 body 候选。按正文质量选择结果，清理后转为 Markdown。声明式延迟片段支持 `template[for]`、`template[shadowrootmode]` 和 `noscript`，处理数量与嵌套深度受限。

文本快照最多 32 项、64 MiB，写入后有效期 10 分钟。显式 `offset`、`find`、`pages` 或 image 模式可以复用快照，普通首次读取重新请求。PDF 缓存原始字节和逐页文本，解析器与渲染图片在处理后释放。

网络与认证规则见[网络配置](network.md)。常见错误包括 `INVALID_URL`、`BLOCKED_ADDRESS`、`AUTH_CONFIRMATION_REQUIRED`、`HTTP_ERROR`、`RESPONSE_TOO_LARGE`、`CONVERSION_FAILED`、`TIMEOUT` 和 `ABORTED`。

# 网页工具

网页工具分为搜索和抓取：

- `websearch`：搜索公开网页索引，返回标题、URL 和提供方抽取的相关内容。
- `webfetch`：读取一个已知 HTTP(S) URL，返回有界文本。

## 加载生命周期

工具参数和结果位于 `core/types.ts`，配置类型位于 `config-types.ts`，HTTP 与内容转换类型分别位于 `network/types.ts` 和 `content/types.ts`。

扩展启动时只同步注册工具模式、渲染器和事件，不加载网络运行时，也不执行后台预热。首次工具调用共享同一个运行时加载 Promise。并发调用不会重复创建运行时。

运行时按能力拆分。只调用 `websearch` 时不加载 WebFetch 和 Cookie 执行链。只调用 `webfetch` 时不加载搜索路由器和提供方。同一网络配置签名的安全调度器由两条能力链共享，并按需创建。搜索提供方只在路由器执行到对应分支时加载。Cookie 存储只在配置启用且域名命中允许列表时加载。

`source`、JSON、XML 和普通文本不会加载 DOM、Readability 或 Turndown。只有 `readable` HTML 会加载转换链。配置使用共享 JSONC 加载器和仓库的 Schema 校验器，并发读取同一配置快照时共享一个 Promise。

成功配置按文件标识、大小和时间戳缓存，每次返回隔离副本。文件变化后会重新读取和校验。读取期间发生变化时会重试。配置错误不会写入成功缓存，下一次工具调用会再次读取。默认值全部由 `agent/defaults/web-tools.jsonc` 提供，TypeScript 只做规范化和语义校验。

搜索、抓取、提供方代码和 Cookie 存储分别按需加载。扩展加载运行时失败后，下次调用可重新尝试。搜索会话只持有进行中的请求。每次请求使用自己的配置和已解析凭据，路由器和提供方不再维护配置签名驱动的实例缓存。网络配置或 API key 更新后，同名搜索也会另行执行，已经开始的请求不变。`session_shutdown` 不加载未使用的能力，先等待已经开始的调用结束，再清理会话状态和共享连接。

需要向允许列表中的来源发送 Cookie 时，运行时只依赖 `WebFetchInteractionPort.confirmAuthentication()`，不依赖 Pi TUI。原生 TUI 与 RPC Extension UI 都能注入该端口。JSON 和打印模式没有端口时返回 `AUTH_CONFIRMATION_REQUIRED`。确认对话框只是适配器。抓取结果和错误结构不依赖组件或通知。

使用 `bun scripts/bench-web-tools.mjs` 运行进程冷启动、文件系统暖态的回归基准。脚本记录以下指标：

- 网页工具模块的 Bun 导入与注册耗时。TUI 和完整 CLI 启动由统一基准的 `startup` 套件测量。
- 首次及后续 `websearch` 和 `source` 模式 `webfetch` 的耗时。使用真实运行时和搜索提供方，仅在基准进程内替换 Undici 的 HTTP 响应。Undici 预加载不计入这两项耗时。
- 模型不支持工具图片时，直接图片响应体的短路耗时。
- 四类合成 HTML 的转换耗时和进程最大常驻内存。这四类页面分别是 3–5 MB 的声明式延迟讨论页、无语义容器的视频元数据页、大型普通文章和包含大量无效模板或 JSON-LD 的恶意页面。

基准不访问真实网络，也不保存真实站点页面或 Cookie。可用 `--runs=N` 调整采样次数。

## `websearch`

```ts
websearch({
  query: string,
  limit?: number,
})
```

- `query`：支持 `site:`、`-site:`、引号、错误码和版本号。域名操作符会提取为统一过滤条件，其他查询内容保留。
- `limit`：合并去重后的总条数上限，范围 1 到 20。默认使用配置 `websearch.default_results`，值为 8。
- 各提供方的 `max_results` 独立限制该提供方的结果条数，默认 5。请求数量取它与 `limit` 的较小值。不支持数量参数的接口由本地截断。

配置中的 `websearch.include_domains` 和 `websearch.exclude_domains` 是每次搜索都会应用的全局域名过滤，默认均为空。`query` 中的 `site:` / `-site:` 会在此基础上继续合并。配置或合并结果中的包含、排除域名不得重叠。

### 搜索后端

提供方不暴露给模型，分为主组和辅助组：

- `websearch.primary_providers`：按顺序回退，默认 `brave_api → exa_api → tavily → exa_mcp`。请求失败或域名过滤后无结果时继续下一家。首个非空批次作为主结果，不为补满条数继续回退。
- `websearch.auxiliary_providers`：全部并发请求，默认顺序为 `tinyfish → anysearch`。辅助请求与主组同时启动，即使主结果已达到总条数上限也会执行。
- 两组须包含全部六个引擎且不重复，任一组可以为空。各引擎的 `enabled` 控制启停。未启用的引擎会被跳过。Exa MCP 无需凭据，AnySearch 支持匿名访问，其他引擎缺少凭据时会被跳过。
- 先合并主结果，再按辅助组配置顺序追加结果。按规范化 URL 去重，重复时保留排在前面的结果，最后按 `limit` 截断并连续编号。请求完成顺序不影响结果顺序。
- 单家失败不丢弃其他家的成功结果。主组不可用时可以只返回辅助结果，全部无可用结果时返回失败。总截止时间到期后保留已完成的结果，用户取消则终止整个搜索。

默认值位于 `agent/defaults/web-tools.jsonc`。用户可在 `~/.pi/agent/configs/web-tools.jsonc` 中覆盖，例如优先 Exa：

```jsonc
{
  "websearch": {
    "primary_providers": ["exa_api", "brave_api", "tavily", "exa_mcp"],
    "auxiliary_providers": ["tinyfish", "anysearch"],
    "default_results": 8,
    "exa_api": { "max_results": 5 },
    "tinyfish": { "max_results": 5, "api_key": "$TINYFISH_API_KEY" },
    "anysearch": { "max_results": 5, "api_key": "$ANYSEARCH_API_KEY" }
  }
}
```

分组、顺序、条数和启停配置在下次调用生效，已开始的请求继续使用原配置。旧 `provider_order` 已移除，现有覆盖文件需改用上述分组字段。设置界面支持调整分组、组内顺序及各引擎的条数上限。已有分组覆盖须包含 `anysearch` 和 `exa_mcp`，否则配置校验失败。可删除分组覆盖以恢复默认顺序。

约束：

- 除 Exa MCP 外，各 provider 使用 `api_key`：可直接填写 key，也可用 `$NAME` / `${NAME}` 引用环境变量。解析规则与 `openai-compatible-provider` 一致。除 AnySearch 改用匿名访问外，空字符串、空白值或无法解析的引用会自动禁用该 provider。引用随后可用时会在下次搜索自动恢复。默认分别引用 `BRAVE_SEARCH_API_KEY`、`EXA_API_KEY`、`TAVILY_API_KEY`、`TINYFISH_API_KEY`、`ANYSEARCH_API_KEY`，推荐使用环境变量，避免把 key 写入配置文件。
- 搜索 API endpoint 只允许公开 HTTP(S) literal URL，拒绝 userinfo、localhost 和 literal 私网/回环/link-local IP。
- Brave 和 AnySearch 将域名条件重建为 `site:` / `-site:`，多个包含域名使用 OR。Exa API、Exa MCP、Tavily 和 TinyFish 使用结构化域名参数。
- Brave 默认使用 `https://api.search.brave.com/res/v1/llm/context`，读取 `grounding.generic`、`grounding.poi` 和 `grounding.map` 中的标题、URL 与全部 snippets。不主动设置内容 token 预算，使用 Brave 默认值。
- Exa 固定使用 `type: auto`，不自动限定内容分类。Exa API 默认请求 `contents: { highlights: { dynamic: true } }`，同时发送 `Exa-Beta: dynamic-highlights-2026-08-28`。Dynamic Highlights 仍为预览功能，会综合多个结果分配内容预算，不设置 `maxCharacters`。Exa MCP 启用 highlights，不设置 `textMaxCharacters` 或 `highlightsMaxCharacters`，两者均使用提供方默认内容预算。Tavily 固定使用 `search_depth: basic`。
- Brave 的 `extra_snippets` 和 Exa API、Exa MCP 的 `highlight_chars` 配置已移除。现有覆盖文件须删除这些字段。显式覆盖 Brave 普通搜索 endpoint 的用户须改为 LLM Context endpoint。
- Exa MCP 默认连接 `https://mcp.exa.ai/mcp`，通过官方 MCP SDK 调用 `web_search_advanced_exa`，无需 API key。使用结构化域名参数，读取 JSON 中的标题、URL、highlights 和 text，不暴露额外工具给模型。初始化与搜索共用提供方超时和剩余总预算，不自动重连或跟随重定向。每次请求使用独立会话，结束时尝试终止远端会话，清理最多额外等待一秒，本地连接始终关闭。公共服务受免费限流约束，零配置可用不保证服务始终可用。有凭据的前序引擎连续超时可能耗尽总预算，导致 MCP 未被调用。
- TinyFish 使用 `GET https://api.search.tinyfish.ai` 和 `X-API-Key`。仅请求首页，读取标题、URL 和 `snippet`，不自动翻页。接口未提供条数参数，本地应用 `max_results`。
- AnySearch 使用 `POST https://api.anysearch.com/v1/search`，读取 `data.results` 的标题、URL、`content` 和 `snippet`。`max_results` 上限为 10，不自动限定垂直领域。有密钥时使用 Bearer 认证，缺少凭据时省略认证头。认证请求返回 401、402 或 403 时，最多重试一次匿名请求，重试与原请求共用提供方超时和总截止时间。网络错误、超时及普通限流不触发匿名重试。匿名访问按 IP 限流并使用每日免费额度。匿名额度耗尽时不继续重试，也不保存或使用响应中的新凭据。
- 结果仅做 URL 规范化、相同 URL 去重和显式域名过滤。保留提供方顺序，不按相关度、摘要长度或域名多样性过滤、补搜或重排。
- 不执行 JavaScript，不使用 headless browser。
- 不读取搜索结果页面，不自动调用 `webfetch`。
- 不发送 `cookies.txt`，也不尝试登录搜索引擎。

### 返回内容

返回主结果与辅助结果的去重汇总，最多 `limit` 条：

```xml
<websearch>
[1] Pi Coding Agent
https://example.com/pi
Search result snippet.
</websearch>
```

查询、实际贡献结果的 `providers`、每条结果的 `provider` 和带主辅角色的尝试记录保留在 `details`，不重复进入模型正文。不可信内容规则由 prompt guideline 声明。

每条结果的 `snippet` 保留提供方返回的全部非空文本片段，包括 Brave 的 snippets、Exa 的 highlights、Exa MCP 的 text，以及其他提供方的 description、content 或 snippet。片段按原始顺序以空行连接，只去除完全重复的片段，不按查询选片，不按字符数截断标题或内容。内容保留换行、缩进和 Unicode，清理终端控制字符，模型正文中的 XML 特殊字符会转义。结构化结果使用相同的完整内容。TUI 展示仍使用紧凑预览，不影响模型收到的内容。

提供方仍会应用自身的内容预算。结果条数、超时和响应字节上限继续生效，字节超限返回错误，不静默截断内容。搜索内容不保证覆盖整页，需要更多内容时继续用 `webfetch` 读取选定 URL。

失败时模型只收到紧凑错误标签，完整错误结构保留在 `details`：

```xml
<error tool="websearch" code="HTTP_ERROR">
provider request failed.
</error>
```

### 限制

- 只搜索公开索引。登录墙后的内容由 `webfetch` 配合 `cookies.txt` 处理。
- URL 会删除 fragment 和明确追踪参数，并按规范化 URL 去重。
- 摘要和标题按不可信纯文本处理，模型输出会转义 XML 字符。
- 搜索只合并相同 key 的并发 in-flight 请求，不缓存已完成结果，也不保留 provider negative cache。
- 并发请求的合并键包含搜索配置、API key 哈希和网络配置签名。提供方接收本次请求的数据，不保留跨调用健康状态。
- `total_deadline_seconds` 限制整个调用。提供方超时和回退都服从剩余预算。

### 错误码

```text
INVALID_ARGUMENT, CONFIG_ERROR, DNS_FAILED, CONNECTION_FAILED,
TLS_FAILED, TIMEOUT, ABORTED, HTTP_ERROR, RATE_LIMITED,
QUOTA_EXHAUSTED, RESPONSE_TOO_LARGE, UNSUPPORTED_CONTENT_TYPE,
NO_PROVIDER_AVAILABLE, PARSE_FAILED
```

## `webfetch`

```ts
webfetch({
  url: string,
  mode?: "readable" | "source" | "image",
  pages?: string,
  find?: string,
  offset?: number,
})
```

- `readable`：HTML 响应使用 LinkeDOM 解析。解析器先分析 `<title>`、唯一 `h1`、description、Open Graph、Twitter Card 和受限 JSON-LD，生成 Readability、`main`、`article`、`[role=main]`、`[itemprop=articleBody]`、JSON-LD 正文和 `body` 候选；不再生成标题祖先候选。Readability 只把聚焦的语义根或最终 body fallback 候选克隆到临时合成文档，并通过 `serializer` 返回正文节点，不再序列化后重新解析。最终选中候选直接清理，不为清理再克隆一次。只对最终主正文执行一次 Turndown，仍传入 HTML 字符串，以满足 GFM 插件对表格 DOM 的要求。候选质量只依据标题保留、有效文本、链接密度、短链接列表、结构元素、媒体与导航/推荐/表单占比，并按固定顺序选择。同一 DOM 根的质量只计算一次。标准 head 信号、媒体节点、页面类型信号和顶层延迟目标分别使用单次节点快照，不再为每类字段重复遍历 DOM。`<base href>` 只用于解析 HTTP(S) 候选 URL，不会触发请求。已确认的客户端空壳会直接使用结构化正文或 metadata，不再进入 Readability 和正文质量选择。JSON-LD 只读取已知字段，并受总字符数、脚本数、对象数、遍历节点数和递归深度硬上限保护；无效或超限数据只保留通用 `structured_data/invalid_or_limited` 遗漏。声明式内容支持整个静态文档内的 `template[for]`、`template[shadowrootmode]`，以及 body 内的 `noscript` fallback。成功替换的目标与声明从同一基础文档移除，展开片段单独清理并转成延迟 section，不复制整页 DOM。片段最多处理 64 个、嵌套最多 8 层，重复、缺失、歧义、循环和超限声明按边界处理；普通未匹配 `<template>` 继续删除。URL 路径以 `.html`/`.htm` 结尾时即使响应头误报也按 HTML 处理。source、JSON、XML、纯文本保持原有轻量路径，不加载 DOM、Readability 或 Turndown。
- `source`：读取解码后的响应源码文本，支持 `find` 选片，不按锚点选读。不支持 PDF 和图片二进制。
- `image`：显式读取图片直链、网页主图或 PDF 页面图片，不返回网页正文，不接受 `find` 或 `offset`，不提供网页截图。网页没有主图时明确报错。
- `pages`：仅 PDF，使用从 1 开始的物理页码，支持 `N`、`N-M`、`N-`，逗号分隔。默认选择全部页，受解析或渲染页数限制。
- `offset`：对转换后的文本切片，默认从 0 开始。使用锚点或 PDF 页选区时，偏移和总长度相对所选内容。`find` 将 offset 解释为查找起点。工具不接受 `limit`，字符预算由 `webfetch.limits.default_output_chars` 控制，不含包装和位置标签。长内容或尚有命中时返回 `range.has_more` 和 `range.next_offset`，继续读取时保留相同 URL、mode、pages、find，原样传回模型输出中的 `next`。
- 文本响应保存在有时间和字节上限的内存快照中，不保存 DOM、响应头对象或返回的图片。显式传入 `offset`、`find`、`pages` 或使用 `image` 模式时复用快照，否则重新请求。没有可用快照时重新下载转换。HTML 按文本模式、锚点和媒体解析开关分别缓存，查找词不参与缓存键。显式 `image` 可复用已启用媒体解析的 `readable` 快照。PDF 缓存原始字节和按页提取的文本，供不同页选区及文本、图片模式共用。缓存最多 32 项、64 MiB，每次写入后有效期为 10 分钟，不保留打开的 PDF 解析器或渲染图片。
- `webfetch.readability.char_threshold`：Readability 接受正文结果的最少字符数。
- `webfetch.media.mode` 默认 `auto`，只允许显式 `mode: "image"` 请求返回图片。普通读取不返回图片直链或网页主图。
- `on` 在允许显式图片请求的基础上，普通 `readable` 读取也可自动返回图片直链和网页主图。PDF 仍默认提取文本。
- `off` 禁止图片输出，显式 `image` 请求也在下载前被拒绝。当前模型不支持图片时，显式请求同样明确报错。

启用媒体解析时，从已选正文的 `img`/`srcset`/`picture`、视频 poster、Open Graph、Twitter Card 和 JSON-LD 声明中选出至多一张主图。正文位置、标准主图声明、尺寸、alt 和标题距离加权，hidden、presentation、微小图标、avatar、logo 与装饰图降权。图片直链复用首次响应字节。网页主图经同一 URL、DNS、redirect 和 Cookie 安全链受限下载，JPEG、PNG、WebP、GIF 按实际字节嗅探后作为原生图片返回，由模型适配层处理不同 API 的图片传输。`webfetch.media.response_bytes` 控制独立图片响应上限。

策略不允许自动图片输出时，跳过 HTML 图片候选收集与主图下载，不把主动省略图片报告为遗漏。若响应头已声明受支持图片，但媒体策略、source 模式、find、后续 offset 或模型能力已确定不返回图片，则在响应头阶段取消图片正文。未声明类型时仍需读取受限字节来识别响应。

### 页内查找

```ts
webfetch({ url: "https://example.com/docs#cancellation", find: "AbortSignal" })
```

- `find` 是 1–512 字符的字面子串，忽略大小写，不做词边界推断、语义匹配或查询语法解析。匹配不改写原文，不额外统一空白或解码内容。可以直接调用，不要求先读取网页。
- HTML `readable` 查找已提取的 Markdown，先应用原生锚点选区。`source` 查找源码。Markdown、普通文本、CSV、JavaScript、JSON、XML、RSS 和 Atom 都查找当前文本表示。JSON 中的 `"\\u4e2d"` 不会因查询 `中` 而命中，也不支持字段路径。
- `webfetch.limits.find_max_passages` 限制每次返回的上下文片段数，默认 `8`，接受正整数。邻近命中合并后计数，可在用户配置中覆盖。优先保留能放入预算的完整段落和短围栏代码块，否则在命中附近截取。默认单片段最多 800 字符，完整查找串更长时以其长度为下限，所有片段共用运行时字符预算。若合法查找串的 UTF-16 长度超过配置预算，本次预算提高到该串长度，避免切断完整命中。
- 每个片段用 `[start-end]` 标记原文的左闭右开字符范围，坐标单位为 UTF-16，与普通 offset 相同。没有命中时返回 `matches="0"`，不是工具错误，也不扩大范围或切换模式。
- `matches` 只统计本次片段中完整返回的不重叠命中，不是整页总数。`next` 是下一处未完整返回命中的起点，使用同一个 find 继续查找。扩读时去掉 find，显式传入片段起点作为 offset，可复用同一 snapshot，包括 offset=0。
- 查找只返回文本，不下载主图，主动省略媒体不产生 `primary_media` 遗漏。iframe、未解析声明和客户端空壳等真实遗漏仍保留。零命中不代表未返回的动态内容中不存在该字符串。
- PDF 搜索提取的文本层，有 `pages` 时仅搜索选定页。没有文本层的页不会执行 OCR，会明确提示使用 `mode: "image"`。不搜索直接图片、音视频流或其他二进制，也不搜索图片响应的占位说明。视频和音频网页只查找已提取的静态文字或文字稿。

```xml
<webfetch kind="article" matches="2" next="4200">
[620-760]
First matching excerpt.

[2100-2240]
Second matching excerpt.
</webfetch>
```

`details.range.kind` 区分 `read` 和 `find`。普通读取保留 start/end，查找结果保留起点、命中数和 passages 数组，不把离散片段声明成连续范围。展开预览只展示查找片段，遥测记录查找词长度和返回命中数，不记录查找词原文。

### PDF 和图片

```ts
webfetch({ url: "https://example.com/diagram.png", mode: "image" })
webfetch({ url: "https://example.com/report.pdf", find: "Revenue" })
webfetch({ url: "https://example.com/report.pdf", pages: "12-14" })
webfetch({ url: "https://example.com/report.pdf", mode: "image", pages: "13" })
```

- PDF 根据 MIME 或 `%PDF-` 文件签名识别，不依赖 URL 扩展名。下载继续使用相同的认证、重定向、网络访问和响应大小限制。
- 默认提取文本，每段附带 `[page N]`。查找片段同时标记字符位置和物理页码。页范围先排序、合并重叠与相邻范围，再裁剪结束页。起点越界或范围倒置报错。
- 文本层不包含完整视觉内容，返回 `pdf_content/pdf_text_only`。所选页没有可提取文本时返回 `pdf_content/no_text_layer`，零命中不能代表图片中不存在该词。不做 OCR。
- 每次文本选择最多 500 页、500 万 UTF-16 字符，超限需缩小 `pages`。PDF 处理单独受 `webfetch.timeout_seconds` 限制，并响应调用取消。
- `image` 每次最多渲染 20 页，剩余范围由 `next_pages` 返回，下次传给 `pages`。页码标记与原生图片交替输出。PDF 渲染最长边限制为 2000 像素，以限制内存占用。工具不再额外缩放图片，SDK 在结果进入历史前统一应用当前模型的 `inputLimits.images.resize` 和 `images.autoResize`。当前模型不支持图片时明确报错，可改用文本模式。
- PDF 不解释 URL fragment，使用 `pages` 选页。密码保护和损坏文档返回解析错误。
- `details.pdf` 保存总页数、选中页范围和后续页范围。模型标签使用 `pages="1-20/22"` 和 `next_pages="21-22"`，与文本续读的 `next` 区分。

PDF 加载、文本提取和渲染位于共享的 `harness/media/`。范围语法位于 `harness/content-ranges.ts`。`web-tools` 与 `file-tools` 各自负责下载或本地读取、结果格式和错误转换，不相互依赖。

### 原生锚点选读

`readable` 和 `image` 模式支持 `https://example.com/docs#authentication`。`image` 仅返回选区内的主图：

- 按解码后的 fragment 精确匹配静态 HTML 的 `id`，其次匹配 `<a name>`。标题内锚点和紧邻标题之前的空 `<a>` 也指向该标题。
- 标题目标包含其子章节，到下一个同级或更高层级标题前结束，范围不越过所属 `main`、`article` 或 `[role=main]`。其他目标只读取目标子树。
- 显式选区不经过 Readability 正文筛选，仍应用安全节点清理、链接绝对化和头像过滤。选区外的正文、页面元数据、主图和遗漏不混入结果。章节外明确指向选区内目标的 `template[for]` 仍会解析。
- 返回 `anchor` 标记实际选区。找不到静态目标、fragment 无法解码或响应不是 HTML 时返回 `ANCHOR_NOT_FOUND`。不生成标题 slug、不解释客户端路由、不回退到整页。移除 fragment 可显式读取整页。
- 有锚点时优先请求 HTML，fragment 不发送给服务器。重定向未指定 fragment 时继承原锚点，显式 fragment 替换原值，单独的 `#` 清空选区。
- 正文链接保留 fragment。

`webfetch` 不搜索、不执行 JavaScript、不点击链接、不提交表单、不访问本机或私网。

图片候选收集和主图评分位于 `content/`，图片响应识别和安全下载位于 `fetch/`。只为图片构造候选，声明的 MIME 不参与最终判断，实际返回类型由响应字节嗅探确定。

视频和音频只保留页面类型及未返回原因，不收集或下载流地址。视频页可返回 poster 或标准缩略图，并通过 `primary_media/video_not_returned` 明确报告视频本体未返回。音频页对应报告 `primary_media/audio_not_returned`。

标题优先使用唯一 `h1`、最终正文标题，其次为 Open Graph、JSON-LD、Twitter Card 和 `<title>`。输出按标题/必要元数据、主正文、结构化内容和延迟内容组成 section。正文 section 按规范化文本相等或包含关系去重，标题元数据不参与该比较，避免正文包含标题词时被整段删除。metadata description 只在正文缺失时补充，不覆盖或重复已有正文。

HTML 在转 Markdown 前会移除头像图片，但保留作者名称和个人页文本链接。判定组合使用 Schema.org、`rel=author`、microformats 等作者语义，严格的个人页路由结构、同目标文本链接、可解析尺寸和明确的 DOM 角色属性。不扫描图片 URL，也不让 alt 文案或单个模糊关键词独立触发删除。基础正文和声明式延迟正文使用同一过滤链。

成功结果固定包含 `scope: "static_response"`，并用 `page_kind` 标记 article、image、video、audio、pdf 或 generic，用 `text_source` 标记 readability、semantic、body、metadata 或 pdf。`completeness` 只报告静态响应中已检测到的真实遗漏，锚点请求只判断所选内容。无已知遗漏时为 `complete`，不表示本次返回了整页。锚点选读、查找选片、字符切片和续读时主动省略主图都不产生遗漏，未读完的文本由 `range` 和模型侧 `next` 表示。

首段应返回的图片必须实际返回。视频和音频即使已有文字或缩略图仍为 `partial`。客户端空壳、未解析声明、iframe、受限结构化数据或主图失败也为 `partial`。普通脚本存在本身不构成遗漏。`complete` 不代表任意客户端状态、交互、登录后 API 或响应中无法检测的动态内容已返回。

`details.omissions` 保留完整的类别和原因结构，可能包含以下值：

```text
deferred_content/unresolved_declaration
primary_media/*
embedded_content/iframe_not_fetched
interactive_content/client_rendered
structured_data/invalid_or_limited
pdf_content/pdf_text_only
pdf_content/no_text_layer
```

模型侧使用紧凑 `<webfetch>` 包装：`kind` 始终存在，锚点选读时输出 `anchor`，查找时输出本次 `matches`。只有 metadata fallback 才输出 `source="metadata"`。真实遗漏原因去重后合并进 `partial`。有后续正文时只输出数字 `next`，不再输出 `partial="range"`。requested URL 已存在于工具调用中，因此仅在跳转后输出不同的 `final`。固定的静态响应范围和不可信内容规则由 prompt guideline 声明，不在每次结果中重复。

```xml
<webfetch kind="video" partial="video_not_returned">
# Title

Static response content.
</webfetch>
```

模型只能依据已返回 section 和媒体。看到 `partial` 时必须披露限制，不能根据标题推测缺失的视频、图片、评论或动态内容。`deferred_fragments` 和 `media` 分别记录发现/解析及发现/返回数量，延迟摘要另记录是否触及上限。分页 snapshot 只保存正文和页面类型、正文来源、遗漏、延迟片段计数及主图 URL 等紧凑分析摘要，不保存 DOM、完整诊断树或图片字节。

失败时模型只收到紧凑错误标签，完整错误结构保留在 `details`：

```xml
<error tool="webfetch" code="HTTP_ERROR">
403 Forbidden
</error>
```

### 错误码

```text
CONFIG_ERROR, INVALID_ARGUMENT, INVALID_URL, BLOCKED_ADDRESS, COOKIE_ERROR,
AUTH_CONFIRMATION_REQUIRED, DNS_FAILED,
CONNECTION_FAILED, TLS_FAILED, TIMEOUT, ABORTED,
TOO_MANY_REDIRECTS, HTTP_ERROR, RESPONSE_TOO_LARGE,
UNSUPPORTED_CONTENT_TYPE, CONVERSION_FAILED, ANCHOR_NOT_FOUND
```

## 共享网络策略

默认配置位于 `agent/defaults/web-tools.jsonc`，用户覆盖位于 `agent/configs/web-tools.jsonc`。不读取项目配置。未知字段会被 schema 拒绝。分层规则见[配置分层](configuration.md)。

### 代理

```json
{
  "network": {
    "proxy": {
      "enabled": false,
      "http_proxy": "",
      "https_proxy": "",
      "socks5_proxy": ""
    }
  }
}
```

- `enabled=false` 时始终直连，且不读取 `HTTP_PROXY`、`HTTPS_PROXY` 等进程环境变量。
- `enabled=true` 时至少需要一个非空端点，所有 Web 请求都会走代理，不会因某个协议字段为空而静默直连。
- HTTP 目标依次选择 `http_proxy`、`socks5_proxy`、`https_proxy`。HTTPS 目标依次选择 `https_proxy`、`socks5_proxy`、`http_proxy`。
- `http_proxy` / `https_proxy` 接受 `http://` 或 `https://` 代理 URL。`socks5_proxy` 接受 `socks5://`。允许在 URL userinfo 中配置代理认证。端点只允许 origin，不接受 path、query 或 fragment。
- SOCKS5 使用 Undici 的实验性实现，首次使用时 Node.js 会输出一条 `ExperimentalWarning`。
- 代理服务器可以位于本机或私网。目标域名仍先在本地执行安全 DNS 校验，再把已校验 IP 交给代理，同时保留原始 Host 与 TLS SNI。代理不会绕过目标 SSRF 策略。

### DNS 与地址策略

- `network.fake_ip_ranges`：两个 Web 工具共用的安全 DNS fake-ip CIDR。只支持 `198.18.0.0/15` 内的子网。
- 配置的 fake-ip CIDR 只放行域名 DNS 解析结果。URL 直接写 IP 仍会拒绝。
- 搜索 API endpoint 的静态 URL 检查复用基础 URL guard。`webfetch` 仍保留自己的 DNS、redirect 和 SSRF 复检逻辑。
- 直连和代理模式下，目标 DNS 解析结果都必须全部是公网地址或已配置 fake-ip。Approval Gate 批准私网 origin 后，`webfetch` 只为该 origin 使用审批时固定的地址。
- `webfetch` 在查询快照前校验首次 URL，缓存键和 HTTP 请求复用已校验的目标。主图在下载前独立校验，每个重定向目标仍重新执行 URL、DNS 和 Cookie 检查。私网批准不会扩展到其他协议、主机或端口。
- `websearch` 使用配置的公开 endpoint，3xx 作为 HTTP 错误，不跟随。

`approval-gate` 默认要求确认解析到 localhost、私网地址或其他非公网地址的 `webfetch` origin。会话和持久放行规则都按完整 origin 匹配。每次调用仍会重新解析地址并签发当前调用使用的固定地址。禁用 Approval Gate 不会关闭 `webfetch` 自身的地址限制。

## Cookie

Cookie 只供 `webfetch` 使用。默认文件：`agent/cookies.txt`，格式为 Netscape/Mozilla `cookies.txt`。

Unix 权限必须禁止 group/other 读取：

```bash
chmod 600 ~/.pi/agent/cookies.txt
```

Cookie 发送需同时满足：

- `webfetch.cookies.enabled` 为 `true`。
- `webfetch.cookies.domains` 命中目标 host。
- `cookies.txt` 自身的 domain/path/secure/expiry 匹配。

allowlist 规则：

- `example.com` 只匹配 `example.com`。
- `*.example.com` 只匹配子域名，不匹配裸域。

认证确认：

- `always`：每次发送 Cookie 前询问。
- `session`：每个 origin 每会话首次询问。
- `never`：命中 allowlist 后直接发送。

响应 `Set-Cookie` 只更新内存 CookieJar，不写回 `cookies.txt`。错误、renderer、模型输出不包含 Cookie 名称和值。

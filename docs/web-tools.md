# Web 工具

Web 工具分为搜索和抓取：

- `websearch`：搜索公开网页索引，返回标题、URL 和摘要。
- `webfetch`：读取一个已知 HTTP(S) URL，返回有界文本。

## 加载生命周期

扩展启动时只同步注册工具 schema、renderer 和事件，不加载网络 runtime，也不执行后台预热。首次工具调用复用同一个 runtime 加载 Promise，并发调用不会重复创建 runtime。runtime 内部再按能力拆分：只调用 `websearch` 不加载 WebFetch/Cookie 执行链，只调用 `webfetch` 不加载搜索 router/provider；安全 dispatcher 在两条能力链之间共享并按需创建。搜索 provider 只在 router 实际执行到该分支时加载，因此 Exa 成功不会加载 DDG/HTML parser；Cookie store 只在配置启用且域名命中 allowlist 时加载；source、JSON、XML 和普通文本不会加载 DOM、Readability 或 Turndown，只有 readable HTML 会加载转换链。JSONC parser 和 AJV 也只在确实读到配置文件并需要解析、校验时加载，并发校验复用同一 Promise。成功配置按文件 identity、大小和时间戳缓存，每次返回隔离副本；文件变化会重新读取和校验，读取期间变化会重试。加载失败会清除对应 Promise，后续调用可以重试；`session_shutdown` 不会加载未使用能力，并会等待正在初始化的能力后释放已创建资源。

使用 `npm run bench:web-tools` 运行 process-cold / filesystem-warm 回归基准；脚本记录 Pi TUI ready、无 TUI 扩展加载、首次及后续 fake `websearch` / `webfetch`，以及 DDG parser 的加载和解析耗时，不访问真实网络。可用 `-- --runs=N` 调整采样次数。

## websearch

```ts
websearch({
  query: string,
  limit?: number,
})
```

- `query`：支持 `site:`、`-site:`、引号、错误码和版本号；域名操作符会转成跨 provider 的结构化过滤，router 同时编译 lexical/semantic 形式。
- `limit`：返回 1 到 20 条；默认使用配置 `websearch.default_results`。

配置中的 `websearch.include_domains` 和 `websearch.exclude_domains` 是每次搜索都会应用的全局域名过滤，默认均为空；`query` 中的 `site:` / `-site:` 会在此基础上继续合并。配置或合并结果中的包含、排除域名不得重叠。

### 搜索后端

Provider 是运行时策略，不暴露给模型：

- `brave_api`：默认处理精确关键词、操作符、官方页面、错误信息、当前事件、新闻和导航查询。
- `exa_api`：处理论文、技术博客、长自然语言和语义发现。
- `tavily`：Brave/Exa 结果不足时做独立质量修复或第二索引验证。
- `duckduckgo_html`：仅当三家正式 provider 全部 hard failure、未配置、额度耗尽或处于 cooldown 时灾备。

约束：

- 各 provider 使用 `api_key`：可直接填写 key，也可用 `$NAME` / `${NAME}` 引用环境变量；解析规则与 `openai-compatible-provider` 一致。空字符串、空白值或无法解析的引用会自动禁用该 provider；引用随后可用时会在下次搜索自动恢复。默认分别引用 `BRAVE_SEARCH_API_KEY`、`EXA_API_KEY`、`TAVILY_API_KEY`，推荐使用环境变量，避免把 key 写入配置文件。
- 三家正式 endpoint 只允许公开 HTTP(S) literal URL，拒绝 userinfo、localhost 和 literal 私网/回环/link-local IP。
- 查询在本地确定性编译成保留操作符的 lexical query 与去除操作符、提取域名条件的 semantic query，不额外调用 LLM。
- HTTP 成功仍需经过数量、关键词匹配、snippet、域名多样性和原生分数质量门控；导航与 `site:` 查询不要求域名多样性。
- 大多数调用只请求一个正式 provider；质量不足或 hard failure 时最多请求第二个正式 provider。第二次失败仍保留第一批 partial results，不会继续请求第三个正式 provider。
- 合并结果会规范化 URL、去重、加权 RRF、为跨 provider 共识加分，并默认限制每个 registrable domain 最多两条。provenance 仅保留在 `details`/遥测。
- DDG 结果页使用流式 HTML parser，只抽取结果块所需字段，不构建完整 DOM；既有限流、challenge 检测和熔断保持不变。
- 不执行 JavaScript，不使用 headless browser；
- 不读取搜索结果页面，不自动调用 `webfetch`；
- 不发送 `cookies.txt`，也不尝试登录搜索引擎。

### 返回内容

模型只收到按搜索引擎顺序排列的结果：

```xml
<websearch_results query="pi coding agent" count="2" provider="brave_api" trust="untrusted">
[1] Pi Coding Agent
URL: https://example.com/pi
Snippet: Search result snippet.
</websearch_results>
```

搜索摘要来自搜索结果页，不等于页面正文。需要确认内容时，继续用 `webfetch` 读取选定 URL。

失败时模型只收到紧凑错误标签，完整错误结构保留在 `details`：

```xml
<error tool="websearch" code="HTTP_ERROR">
provider request failed.
</error>
```

### 限制

- 只搜索公开索引；登录墙后的内容由 `webfetch` 配合 `cookies.txt` 处理。
- URL 会解包 DDG `/l/?uddg=...`，删除 fragment 和明确追踪参数，并按规范化 URL 去重。
- 摘要和标题按不可信纯文本处理，模型输出会转义 XML 字符。
- 数据中心或共享出口 IP 可能触发 DDG bot challenge。
- 工具会识别 challenge，但不会绕过 CAPTCHA、换代理或重放请求。
- 搜索结果有会话内 LRU 完成缓存、in-flight singleflight 和短期 negative cache，不写磁盘；完成缓存 TTL 默认 300 秒。
- 会话级 SearchCorpus 保留已发现结果及 provider rank，并只在 query 高度近似、过滤兼容且已有足够强结果时保守复用；`webfetch` 会标记已消费 URL。
- provider 会话状态为 healthy、degraded、cooldown、exhausted 或 misconfigured；401/403、402/额度耗尽、429 Retry-After、timeout/5xx 分别更新状态。配置签名变化会重建 router 并恢复状态。
- `total_deadline_seconds` 限制整个调用；provider timeout、fallback 和 DDG 限流等待都服从剩余预算。
- 会话内 DDG 请求串行发送，默认至少间隔 15 秒；一旦触发 challenge，进入 10 分钟冷却期，冷却期内不继续请求 DDG。
- 该限速只降低触发概率，不能保证 DDG HTML 抓取长期稳定。

### 错误码

`INVALID_ARGUMENT`、`CONFIG_ERROR`、`DNS_FAILED`、`CONNECTION_FAILED`、`TLS_FAILED`、`TIMEOUT`、`ABORTED`、`HTTP_ERROR`、`RATE_LIMITED`、`QUOTA_EXHAUSTED`、`RESPONSE_TOO_LARGE`、`UNSUPPORTED_CONTENT_TYPE`、`NO_PROVIDER_AVAILABLE`、`PROVIDER_BLOCKED`、`PARSE_FAILED`。

## webfetch

```ts
webfetch({
  url: string,
  mode?: "readable" | "source",
  offset?: number,
  limit?: number,
})
```

- `readable`：HTML 先分析 `<title>`、唯一 `h1`、description、canonical、Open Graph、Twitter Card、受限 JSON-LD 和声明式媒体元素，再生成 Readability、`main`/`article`/`[role=main]`/`[itemprop=articleBody]`、标题祖先、JSON-LD 正文和 body 候选。候选质量只依据标题保留、有效文本、链接密度、短链接列表、结构元素、媒体与导航/推荐/表单占比，并按固定顺序选择。`<base href>` 只用于解析 HTTP(S) 候选 URL，不会触发请求。JSON-LD 只读取已知字段，并受总字符数、对象数和递归深度硬上限保护；无效或超限数据只记录遗漏。声明式内容支持整个静态文档内的 `template[for]`、`template[shadowrootmode]`，以及 body 内的 `noscript` fallback；基础正文通过内部标记排除替换目标，展开内容单独清理和转换后作为延迟 section 合并。片段最多处理 64 个、嵌套最多 8 层，重复、缺失、歧义、循环和超限声明按稳定原因跳过；普通未匹配 `<template>` 继续删除。URL 路径以 `.html`/`.htm` 结尾时即使响应头误报也按 HTML 处理；JSON、XML、纯文本保持原文。
- `source`：返回解码后的响应源码文本。
- `offset`/`limit`：对首次转换后的内存 snapshot 切片；长页面结果返回 `range.has_more`、`range.next_offset` 和 `next`，继续读取时使用上次返回的 offset。
- `webfetch.readability.char_threshold`：Readability 接受正文结果的最少字符数。
- `webfetch.media`：`auto` 模式从已选正文的 `img`/`srcset`/`picture`、视频 poster、Open Graph、Twitter Card 和 JSON-LD 声明中统一选出至多一张主图；正文位置、标准主图声明、尺寸、alt 和标题距离加权，hidden、presentation、微小图标、avatar、logo 与装饰图降权。直接图片 URL 复用首次响应字节。当前模型支持图像时，页面主图经同一 URL、DNS、redirect 和 Cookie 安全链受限下载，JPEG、PNG、WebP、GIF 均以实际字节嗅探后作为原生图片内容返回；模型不支持图像时不会发起二次图片请求。`off` 禁用，`response_bytes` 控制独立图片响应上限。

`webfetch` 不搜索、不执行 JavaScript、不点击链接、不提交表单、不访问本机或私网。

视频和音频流只记录存在，不会下载。视频页可返回 poster 或标准缩略图，并通过 `primary_media/video_not_returned` 明确报告视频本体未返回；音频页对应报告 `primary_media/audio_not_returned`。

标题优先使用最终正文标题，其次为 Open Graph、JSON-LD、Twitter Card 和 `<title>`。canonical 依次使用 `link[rel=canonical]`、`og:url` 和最终响应 URL。输出按标题/必要元数据、主正文、结构化内容和延迟内容组成 section；只按规范化文本相等或包含关系去重。metadata description 只在正文缺失时补充，不覆盖或重复已有正文。

HTML 在转 Markdown 前会移除头像图片，但保留作者名称和个人页文本链接。判定组合使用 Schema.org、`rel=author`、microformats 等作者语义，严格的个人页路由结构、同目标文本链接、可解析尺寸和明确的 DOM 角色属性；不扫描图片 URL，也不让 alt 文案或单个模糊关键词独立触发删除。基础正文和声明式延迟正文使用同一过滤链。

成功结果固定包含 `scope: "static_response"`，并用 `page_kind` 标记 article、image、video、audio 或 generic，用 `text_source` 标记 readability、semantic、heading、body 或 metadata。`completeness` 只判断当前静态响应中已检测内容是否完整：文章正文无已知遗漏时为 `complete`；图片必须实际返回；视频和音频即使已有文字或缩略图仍为 `partial`；客户端空壳、文本分段、未解析声明、iframe、受限结构化数据或主图失败也为 `partial`。普通脚本存在本身不构成遗漏；`complete` 不代表任意客户端状态、交互、登录后 API 或响应中无法检测的动态内容已返回。

`details.omissions` 保留完整 kind/reason 结构，包括 `text_range/range`、`deferred_content/unresolved_declaration`、`primary_media/*`、`embedded_content/iframe_not_fetched`、`interactive_content/client_rendered` 和 `structured_data/invalid_or_limited`。模型侧使用紧凑 `<webfetch>` 包装：`kind` 始终存在；只有 metadata fallback 才输出 `source="metadata"`；遗漏原因去重后合并进 `partial`；有后续正文时只输出数字 `next`；requested URL 已存在于工具调用中，因此仅在跳转后输出不同的 `final`。固定的静态响应范围和不可信内容规则由 prompt guideline 声明，不在每次结果中重复。

```xml
<webfetch kind="video" partial="video_not_returned">
# Title

Static response content.
</webfetch>
```

模型只能依据已返回 section 和媒体；看到 `partial` 时必须披露限制，不能根据标题推测缺失的视频、图片、评论或动态内容。`deferred_fragments` 和 `media` 分别记录发现/解析及发现/返回数量；分页 snapshot 只保存正文和页面类型、正文来源、遗漏、延迟片段计数及主图 URL 等分析摘要，不保存 DOM、完整页面分析对象或图片字节。

失败时模型只收到紧凑错误标签，完整错误结构保留在 `details`：

```xml
<error tool="webfetch" code="HTTP_ERROR">
403 Forbidden
</error>
```

### 错误码

`INVALID_ARGUMENT`、`CONFIG_ERROR`、`INVALID_URL`、`BLOCKED_ADDRESS`、`COOKIE_ERROR`、`AUTH_CONFIRMATION_REQUIRED`、`DNS_FAILED`、`CONNECTION_FAILED`、`TLS_FAILED`、`TIMEOUT`、`ABORTED`、`TOO_MANY_REDIRECTS`、`HTTP_ERROR`、`RESPONSE_TOO_LARGE`、`UNSUPPORTED_CONTENT_TYPE`、`DECODE_FAILED`、`CONVERSION_FAILED`、`OFFSET_OUT_OF_RANGE`。

## 共享网络策略

配置文件：`agent/configs/web-tools.jsonc`。未知字段会被 schema 拒绝。仓库文件完整列出当前有效值，便于直接修改。

- `network.fake_ip_ranges`：两个 Web 工具共用的安全 DNS fake-ip CIDR。默认空；只支持 `198.18.0.0/15` 内的子网。
- 配置的 fake-ip CIDR 只放行域名 DNS 解析结果；URL 直接写 IP 仍会拒绝。
- 三家正式搜索 endpoint 的静态 URL 检查复用基础 URL guard；`webfetch` 仍保留自己的 DNS、redirect 和 SSRF 复检逻辑。
- 每次连接时 DNS 解析结果必须全部是公网地址或已配置 fake-ip。
- `webfetch` 每个 redirect 目标都会重新执行 URL、DNS、Cookie 检查。
- `websearch` 使用配置的公开 endpoint，3xx 作为 HTTP 错误，不跟随。

## Cookie

Cookie 只供 `webfetch` 使用。默认文件：`agent/cookies.txt`，格式为 Netscape/Mozilla `cookies.txt`。

Unix 权限必须禁止 group/other 读取：

```bash
chmod 600 ~/.pi/agent/cookies.txt
```

Cookie 发送需同时满足：

- `webfetch.cookies.enabled` 为 `true`；
- `webfetch.cookies.domains` 命中目标 host；
- `cookies.txt` 自身的 domain/path/secure/expiry 匹配。

allowlist 规则：

- `example.com` 只匹配 `example.com`；
- `*.example.com` 只匹配子域名，不匹配裸域。

认证确认：

- `always`：每次发送 Cookie 前询问；
- `session`：每个 origin 每会话首次询问；
- `never`：命中 allowlist 后直接发送。

响应 `Set-Cookie` 只更新内存 CookieJar，不写回 `cookies.txt`。错误、renderer、模型输出不包含 Cookie 名称和值。

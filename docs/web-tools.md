# 网页工具

网页工具分为搜索和抓取：

- `websearch`：搜索公开网页索引，返回标题、URL 和摘要。
- `webfetch`：读取一个已知 HTTP(S) URL，返回有界文本。

## 加载生命周期

扩展启动时只同步注册工具模式、渲染器和事件，不加载网络运行时，也不执行后台预热。首次工具调用共享同一个运行时加载 Promise。并发调用不会重复创建运行时。

运行时按能力拆分。只调用 `websearch` 时不加载 WebFetch 和 Cookie 执行链。只调用 `webfetch` 时不加载搜索路由器和提供方。同一网络配置签名的安全调度器由两条能力链共享，并按需创建。搜索提供方只在路由器执行到对应分支时加载。因此，Exa 成功时不会加载 DDG 或 HTML 解析器。Cookie 存储只在配置启用且域名命中允许列表时加载。

`source`、JSON、XML 和普通文本不会加载 DOM、Readability 或 Turndown。只有 `readable` HTML 会加载转换链。JSONC 解析器和 AJV 也只在读取到配置文件且需要解析、校验时加载。并发校验共享同一个 Promise。

成功配置按文件标识、大小和时间戳缓存，每次返回隔离副本。文件变化后会重新读取和校验。读取期间发生变化时会重试。配置错误不会写入成功缓存，下一次工具调用会再次由 `loadWebToolsConfig()` 读取。运行时、能力、provider 和 Cookie store 的模块或实例加载在同一会话内只复用一次，加载失败不会自动重试。`session_shutdown` 不会加载未使用的能力。关闭会话时，运行时会等待正在初始化的能力，再释放已经创建的资源。

需要向允许列表中的来源发送 Cookie 时，运行时只依赖 `WebFetchInteractionPort.confirmAuthentication()`，不依赖 Pi TUI。原生 TUI 与 RPC Extension UI 都能注入该端口。JSON 和打印模式没有端口时返回 `AUTH_CONFIRMATION_REQUIRED`。确认对话框只是适配器。抓取结果和错误结构不依赖组件或通知。

使用 `npm run bench:web-tools` 运行进程冷启动、文件系统暖态的回归基准。脚本记录以下指标：

- Pi TUI 就绪和无 TUI 时的扩展加载耗时。
- 首次及后续本地假 `websearch` 和 `source` 模式 `webfetch` 的耗时。
- 模型不支持工具图片时，直接图片响应体的短路耗时。
- DDG 解析器的耗时。
- 四类合成 HTML 的转换耗时和进程最大常驻内存。这四类页面分别是 3–5 MB 的声明式延迟讨论页、无语义容器的视频元数据页、大型普通文章和包含大量无效模板或 JSON-LD 的恶意页面。

基准不访问真实网络，也不保存真实站点页面或 Cookie。可用 `-- --runs=N` 调整采样次数。

## `websearch`

```ts
websearch({
  query: string,
  limit?: number,
})
```

- `query`：支持 `site:`、`-site:`、引号、错误码和版本号。域名操作符会转成跨 provider 的结构化过滤，router 同时编译 lexical/semantic 形式。
- `limit`：返回 1 到 20 条。默认使用配置 `websearch.default_results`。

配置中的 `websearch.include_domains` 和 `websearch.exclude_domains` 是每次搜索都会应用的全局域名过滤，默认均为空。`query` 中的 `site:` / `-site:` 会在此基础上继续合并。配置或合并结果中的包含、排除域名不得重叠。

### 搜索后端

Provider 是运行时策略，不暴露给模型：

- `brave_api`：默认处理精确关键词、操作符、官方页面、错误信息、当前事件、新闻和导航查询。
- `exa_api`：处理论文、技术博客、长自然语言和语义发现。
- `tavily`：Brave/Exa 结果不足时做独立质量修复或第二索引验证。
- `duckduckgo_html`：没有可用正式 provider，或本次最多两个正式请求均 hard failure 且没有可用 partial 结果时作为最终灾备。正式 provider 返回 accepted、partial、用户取消或总 deadline 到期时不调用。

约束：

- 各 provider 使用 `api_key`：可直接填写 key，也可用 `$NAME` / `${NAME}` 引用环境变量。解析规则与 `openai-compatible-provider` 一致。空字符串、空白值或无法解析的引用会自动禁用该 provider。引用随后可用时会在下次搜索自动恢复。默认分别引用 `BRAVE_SEARCH_API_KEY`、`EXA_API_KEY`、`TAVILY_API_KEY`，推荐使用环境变量，避免把 key 写入配置文件。
- 三家正式 endpoint 只允许公开 HTTP(S) literal URL，拒绝 userinfo、localhost 和 literal 私网/回环/link-local IP。
- 查询在本地确定性编译成保留操作符的 lexical query 与去除操作符、提取域名条件的 semantic query，不额外调用 LLM。
- HTTP 成功仍需经过数量、关键词匹配、snippet 和域名多样性质量门控。导航与 `site:` 查询不要求域名多样性。
- 大多数调用只请求一个正式 provider。质量不足或 hard failure 时最多请求第二个正式 provider。第二次失败仍保留第一批 partial results，不会继续请求第三个正式 provider。
- 合并结果会规范化 URL、去重、加权 RRF、为跨 provider 共识加分，并默认限制每个 registrable domain 最多两条。provenance 仅保留在 `details`/遥测。
- DDG 结果页使用流式 HTML parser，只抽取结果块所需字段，不构建完整 DOM。既有限流、challenge 检测和熔断保持不变。
- 不执行 JavaScript，不使用 headless browser。
- 不读取搜索结果页面，不自动调用 `webfetch`。
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

- 只搜索公开索引。登录墙后的内容由 `webfetch` 配合 `cookies.txt` 处理。
- URL 会解包 DDG `/l/?uddg=...`，删除 fragment 和明确追踪参数，并按规范化 URL 去重。
- 摘要和标题按不可信纯文本处理，模型输出会转义 XML 字符。
- 数据中心或共享出口 IP 可能触发 DDG bot challenge。
- 工具会识别 challenge，但不会绕过 CAPTCHA、自动切换代理或重放请求。
- 搜索只合并相同 key 的并发 in-flight 请求，不缓存已完成结果，也不保留 provider negative cache。
- 配置签名包含正式 provider 配置和 API key 哈希；配置或环境变量变化时重建 router。正式 provider 不保留跨调用健康状态。
- `total_deadline_seconds` 限制整个调用。provider timeout、fallback 和 DDG 限流等待都服从剩余预算。
- 会话内 DDG 请求串行发送，默认至少间隔 15 秒。一旦触发 challenge，进入 10 分钟冷却期，冷却期内不继续请求 DDG。
- 该限速只降低触发概率，不能保证 DDG HTML 抓取长期稳定。

### 错误码

```text
INVALID_ARGUMENT, CONFIG_ERROR, DNS_FAILED, CONNECTION_FAILED,
TLS_FAILED, TIMEOUT, ABORTED, HTTP_ERROR, RATE_LIMITED,
QUOTA_EXHAUSTED, RESPONSE_TOO_LARGE, UNSUPPORTED_CONTENT_TYPE,
NO_PROVIDER_AVAILABLE, PROVIDER_BLOCKED, PARSE_FAILED
```

## `webfetch`

```ts
webfetch({
  url: string,
  mode?: "readable" | "source",
  offset?: number,
  limit?: number,
})
```

- `readable`：HTML 整页只解析一次。解析器先分析 `<title>`、唯一 `h1`、description、Open Graph、Twitter Card 和受限 JSON-LD，生成 Readability、`main`、`article`、`[role=main]`、`[itemprop=articleBody]`、JSON-LD 正文和 `body` 候选；不再生成标题祖先候选。Readability 只把聚焦的语义根或最终 body fallback 候选克隆到临时合成文档，不克隆带 head 的完整 Document。只对最终主正文执行一次 Turndown。候选质量只依据标题保留、有效文本、链接密度、短链接列表、结构元素、媒体与导航/推荐/表单占比，并按固定顺序选择。同一 DOM 根的质量只计算一次。标准 head 信号、媒体节点、页面类型信号和顶层延迟目标分别使用单次节点快照，不再为每类字段重复遍历 DOM。`<base href>` 只用于解析 HTTP(S) 候选 URL，不会触发请求。已确认的客户端空壳会直接使用结构化正文或 metadata，不再进入 Readability 和正文质量选择。JSON-LD 只读取已知字段，并受总字符数、脚本数、对象数、遍历节点数和递归深度硬上限保护；无效或超限数据只保留通用 `structured_data/invalid_or_limited` 遗漏。声明式内容支持整个静态文档内的 `template[for]`、`template[shadowrootmode]`，以及 body 内的 `noscript` fallback。成功替换的目标与声明从同一基础文档移除，展开片段单独清理并转成延迟 section，不复制整页 DOM。片段最多处理 64 个、嵌套最多 8 层，重复、缺失、歧义、循环和超限声明按边界处理；普通未匹配 `<template>` 继续删除。URL 路径以 `.html`/`.htm` 结尾时即使响应头误报也按 HTML 处理。source、JSON、XML、纯文本保持原有轻量路径，不加载 DOM、Readability 或 Turndown。
- `source`：返回解码后的响应源码文本。
- `offset`/`limit`：对首次转换后的内存 snapshot 切片。长页面结果返回 `range.has_more` 和 `range.next_offset`，继续读取时使用上次返回的 offset。
- `webfetch.readability.char_threshold`：Readability 接受正文结果的最少字符数。
- `webfetch.media`：`auto` 模式从已选正文的 `img`/`srcset`/`picture`、视频 poster、Open Graph、Twitter Card 和 JSON-LD 声明中统一选出至多一张主图。正文位置、标准主图声明、尺寸、alt 和标题距离加权，hidden、presentation、微小图标、avatar、logo 与装饰图降权。直接图片 URL 复用首次响应字节。当前模型支持图像且所选 API 支持工具结果图片时，页面主图经同一 URL、DNS、redirect 和 Cookie 安全链受限下载，JPEG、PNG、WebP、GIF 均以实际字节嗅探后作为原生图片内容返回。模型不支持图像时不会发起二次图片请求。若响应头已明确声明受支持图片，而 source 模式、后续 offset、模型能力或 API 类型已确定不可能返回图片，WebFetch 会在响应头阶段取消直接图片 body，不下载图片字节。`off` 时跳过 HTML 图片候选收集、排序和主图解析，不把用户主动关闭媒体视为遗漏，也不会因页面存在图片而变为 partial；`response_bytes` 控制独立图片响应上限。OpenAI Chat Completions 的 tool message 只支持文本，因此 `openai-completions` 模型即使支持普通图片输入也不会返回工具图片。Responses 不受影响。

`webfetch` 不搜索、不执行 JavaScript、不点击链接、不提交表单、不访问本机或私网。

视频和音频流只记录存在，不会下载。视频页可返回 poster 或标准缩略图，并通过 `primary_media/video_not_returned` 明确报告视频本体未返回。音频页对应报告 `primary_media/audio_not_returned`。

标题优先使用唯一 `h1`、最终正文标题，其次为 Open Graph、JSON-LD、Twitter Card 和 `<title>`。输出按标题/必要元数据、主正文、结构化内容和延迟内容组成 section。只按规范化文本相等或包含关系去重。metadata description 只在正文缺失时补充，不覆盖或重复已有正文。

HTML 在转 Markdown 前会移除头像图片，但保留作者名称和个人页文本链接。判定组合使用 Schema.org、`rel=author`、microformats 等作者语义，严格的个人页路由结构、同目标文本链接、可解析尺寸和明确的 DOM 角色属性。不扫描图片 URL，也不让 alt 文案或单个模糊关键词独立触发删除。基础正文和声明式延迟正文使用同一过滤链。

成功结果固定包含 `scope: "static_response"`，并用 `page_kind` 标记 article、image、video、audio 或 generic，用 `text_source` 标记 readability、semantic、body 或 metadata。`completeness` 只判断当前静态响应中已检测内容是否完整：文章正文无已知遗漏时为 `complete`。图片必须实际返回。视频和音频即使已有文字或缩略图仍为 `partial`。客户端空壳、文本分段、未解析声明、iframe、受限结构化数据或主图失败也为 `partial`。普通脚本存在本身不构成遗漏。`complete` 不代表任意客户端状态、交互、登录后 API 或响应中无法检测的动态内容已返回。

`details.omissions` 保留完整的类别和原因结构，可能包含以下值：

```text
text_range/range
deferred_content/unresolved_declaration
primary_media/*
embedded_content/iframe_not_fetched
interactive_content/client_rendered
structured_data/invalid_or_limited
```模型侧使用紧凑 `<webfetch>` 包装：`kind` 始终存在。只有 metadata fallback 才输出 `source="metadata"`。遗漏原因去重后合并进 `partial`。有后续正文时只输出数字 `next`。requested URL 已存在于工具调用中，因此仅在跳转后输出不同的 `final`。固定的静态响应范围和不可信内容规则由 prompt guideline 声明，不在每次结果中重复。

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
CONFIG_ERROR, INVALID_URL, BLOCKED_ADDRESS, COOKIE_ERROR,
AUTH_CONFIRMATION_REQUIRED, DNS_FAILED,
CONNECTION_FAILED, TLS_FAILED, TIMEOUT, ABORTED,
TOO_MANY_REDIRECTS, HTTP_ERROR, RESPONSE_TOO_LARGE,
UNSUPPORTED_CONTENT_TYPE, CONVERSION_FAILED
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
- 三家正式搜索 endpoint 的静态 URL 检查复用基础 URL guard。`webfetch` 仍保留自己的 DNS、redirect 和 SSRF 复检逻辑。
- 直连和代理模式下，目标 DNS 解析结果都必须全部是公网地址或已配置 fake-ip。Approval Gate 批准私网 origin 后，`webfetch` 只为该 origin 使用审批时固定的地址。
- `webfetch` 会对每个重定向目标重新执行 URL、DNS 和 Cookie 检查。私网批准不会扩展到其他协议、主机或端口。
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

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

- `query`：原样传给搜索引擎，支持 `site:`、引号、减号等查询语法。
- `limit`：返回 1 到 20 条；默认使用配置 `websearch.default_results`。

### 搜索后端

Provider 是运行时配置，不暴露给模型。默认顺序：

- `exa_mcp`：Exa hosted MCP，默认 URL `https://mcp.exa.ai/mcp?tools=web_search_exa`，工具 `web_search_exa`。
- `duckduckgo_html`：DDG HTML fallback，固定请求 `https://html.duckduckgo.com/html/`。

约束：

- API key 只从 `exa_mcp.api_key_env` 指定的环境变量读取，默认 `EXA_API_KEY`；配置文件不保存 key。
- `exa_mcp.url` 只允许 `http:` / `https:`，拒绝 username/password、`localhost` / `*.localhost`、literal private IP、loopback IP 和 link-local IP。该检查只做 URL literal host 静态校验，不做 DNS 解析。
- Exa 失败后按配置 fallback 到 DDG；DDG 的限流和 blocked 冷却只影响 DDG provider。
- Exa 使用官方 MCP client/Streamable HTTP transport，保留 initialize、SSE、session、重连和协议校验；DDG 结果页使用流式 HTML parser，只抽取结果块所需字段，不构建完整 DOM。
- 不执行 JavaScript，不使用 headless browser；
- 不读取搜索结果页面，不自动调用 `webfetch`；
- 不发送 `cookies.txt`，也不尝试登录搜索引擎。

### 返回内容

模型只收到按搜索引擎顺序排列的结果：

```xml
<websearch_results query="pi coding agent" count="2" provider="exa_mcp" trust="untrusted">
[1] Pi Coding Agent
URL: https://example.com/pi
Snippet: Search result snippet.
</websearch_results>
```

搜索摘要来自搜索结果页，不等于页面正文。需要确认内容时，继续用 `webfetch` 读取选定 URL。

失败时模型只收到紧凑错误标签，完整错误结构保留在 `details`：

```xml
<error tool="websearch" code="MCP_ERROR">
provider request failed.
</error>
```

### 限制

- 只搜索公开索引；登录墙后的内容由 `webfetch` 配合 `cookies.txt` 处理。
- URL 会解包 DDG `/l/?uddg=...`，删除 fragment 和明确追踪参数，并按规范化 URL 去重。
- 摘要和标题按不可信纯文本处理，模型输出会转义 XML 字符。
- 数据中心或共享出口 IP 可能触发 DDG bot challenge。
- 工具会识别 challenge，但不会绕过 CAPTCHA、换代理或重放请求。
- 搜索结果有会话内 LRU 缓存，不写磁盘；TTL 默认 300 秒。
- 会话内 DDG 请求串行发送，默认至少间隔 15 秒；一旦触发 challenge，进入 10 分钟冷却期，冷却期内不继续请求 DDG。
- 该限速只降低触发概率，不能保证 DDG HTML 抓取长期稳定。

### 错误码

`INVALID_ARGUMENT`、`CONFIG_ERROR`、`DNS_FAILED`、`CONNECTION_FAILED`、`TLS_FAILED`、`TIMEOUT`、`ABORTED`、`HTTP_ERROR`、`RESPONSE_TOO_LARGE`、`UNSUPPORTED_CONTENT_TYPE`、`MCP_ERROR`、`NO_PROVIDER_AVAILABLE`、`PROVIDER_BLOCKED`、`PARSE_FAILED`。

## webfetch

```ts
webfetch({
  url: string,
  mode?: "readable" | "source",
  offset?: number,
  limit?: number,
})
```

- `readable`：HTML 清理后转 Markdown；URL 路径以 `.html`/`.htm` 结尾时即使响应头误报也按 HTML 处理；JSON、XML、纯文本保持原文。
- `source`：返回解码后的响应源码文本。
- `offset`/`limit`：对首次转换后的内存 snapshot 切片；长页面结果返回 `range.has_more`、`range.next_offset` 和 `next`，继续读取时使用上次返回的 offset。

`webfetch` 不搜索、不执行 JavaScript、不点击链接、不提交表单、不访问本机或私网。

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
- `exa_mcp.url` 的静态 URL 检查复用基础 URL guard；`webfetch` 仍保留自己的 DNS、redirect 和 SSRF 复检逻辑。
- 每次连接时 DNS 解析结果必须全部是公网地址或已配置 fake-ip。
- `webfetch` 每个 redirect 目标都会重新执行 URL、DNS、Cookie 检查。
- `websearch` endpoint 固定，3xx 作为 HTTP 错误，不跟随。

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

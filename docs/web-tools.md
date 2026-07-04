# Web 工具

Web 工具分为搜索和抓取：

- `websearch`：用 DuckDuckGo HTML 搜索公开网页索引，返回标题、URL 和摘要。
- `webfetch`：读取一个已知 HTTP(S) URL，返回有界文本。

## websearch

```ts
websearch({
  query: string,
  limit?: number,
  recency?: "day" | "week" | "month" | "year",
})
```

- `query`：原样传给搜索引擎，支持 `site:`、引号、减号等查询语法。
- `limit`：返回 1 到 20 条；默认使用配置 `websearch.default_results`。
- `recency`：可选新鲜度过滤，对应 DuckDuckGo `df` 参数。

### 搜索后端

V1 只有 DuckDuckGo HTML 后端，固定请求 `https://html.duckduckgo.com/html/`：

- 不使用第三方搜索 API；
- 不使用 Google、Bing、SearXNG 或 fallback provider；
- 不执行 JavaScript，不使用 headless browser；
- 不读取搜索结果页面，不自动调用 `webfetch`；
- 不发送 `cookies.txt`，也不尝试登录搜索引擎。

### 返回内容

模型只收到按搜索引擎顺序排列的结果：

```xml
<websearch_results query="pi coding agent" count="2" trust="untrusted">
[1] Pi Coding Agent
URL: https://example.com/pi
Snippet: Search result snippet.
</websearch_results>
```

搜索摘要来自搜索结果页，不等于页面正文。需要确认内容时，继续用 `webfetch` 读取选定 URL。

### 限制

- 只搜索公开索引；登录墙后的内容由 `webfetch` 配合 `cookies.txt` 处理。
- URL 会解包 DDG `/l/?uddg=...`，删除 fragment 和明确追踪参数，并按规范化 URL 去重。
- 摘要和标题按不可信纯文本处理，模型输出会转义 XML 字符。
- 数据中心或共享出口 IP 可能触发 DDG bot challenge。
- 工具会识别 challenge，但不会绕过 CAPTCHA、换代理或重放请求。
- 搜索结果有会话内 5 分钟 LRU 缓存，不写磁盘。
- 会话内 DDG 请求串行发送，默认至少间隔 15 秒；一旦触发 challenge，进入 10 分钟冷却期，冷却期内不继续请求 DDG。
- 该限速只降低触发概率，不能保证 DDG HTML 抓取长期稳定。

### 错误码

`INVALID_ARGUMENT`、`CONFIG_ERROR`、`DNS_FAILED`、`CONNECTION_FAILED`、`TLS_FAILED`、`TIMEOUT`、`ABORTED`、`HTTP_ERROR`、`RESPONSE_TOO_LARGE`、`UNSUPPORTED_CONTENT_TYPE`、`PROVIDER_BLOCKED`、`PARSE_FAILED`。

## webfetch

```ts
webfetch({
  url: string,
  mode?: "readable" | "source",
  offset?: number,
  limit?: number,
})
```

- `readable`：HTML 清理后转 Markdown；JSON、XML、纯文本保持原文。
- `source`：返回解码后的响应源码文本。
- `offset`/`limit`：对首次转换后的内存 snapshot 切片；继续读取长页面时用上次返回的 `next_offset`。

`webfetch` 不搜索、不执行 JavaScript、不点击链接、不提交表单、不访问本机或私网。

### 错误码

`INVALID_ARGUMENT`、`CONFIG_ERROR`、`INVALID_URL`、`BLOCKED_ADDRESS`、`COOKIE_ERROR`、`AUTH_CONFIRMATION_REQUIRED`、`DNS_FAILED`、`CONNECTION_FAILED`、`TLS_FAILED`、`TIMEOUT`、`ABORTED`、`TOO_MANY_REDIRECTS`、`HTTP_ERROR`、`RESPONSE_TOO_LARGE`、`UNSUPPORTED_CONTENT_TYPE`、`DECODE_FAILED`、`CONVERSION_FAILED`、`OFFSET_OUT_OF_RANGE`。

## 共享网络策略

配置文件：`agent/configs/web-tools.jsonc`。未知字段会被 schema 拒绝。

- `network.fake_ip_ranges`：两个 Web 工具共用的安全 DNS fake-ip CIDR。默认空；只支持 `198.18.0.0/15` 内的子网。
- 配置的 fake-ip CIDR 只放行域名 DNS 解析结果；URL 直接写 IP 仍会拒绝。
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

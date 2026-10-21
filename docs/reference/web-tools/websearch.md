# websearch

```ts
websearch({ query: string, limit?: number })
```

`query` 支持 `site:`、`-site:`、引号、错误码和版本号。域名操作符转换为过滤条件，其余查询传给提供方。`limit` 为 1–20，默认取配置的 `default_results`。

## 分组与顺序

搜索同时运行主组和辅助组：

- `primary_providers` 按顺序回退，首个非空批次作为主结果。
- `auxiliary_providers` 全部并发，结果按配置顺序追加。
- 先保留主结果，再追加辅助结果，按规范化 URL 去重，最后按 `limit` 截断。

两组需包含全部引擎且没有重复，任一组可以为空。各引擎的 `enabled` 控制启停。单个提供方失败时保留其他成功结果，总截止时间到达时返回已完成结果，用户取消则终止调用。

当前默认值以 [`web-tools.jsonc`](../../../agent/defaults/web-tools.jsonc) 为准：主组 Exa API、Brave、Tavily、Exa MCP，辅助组 TinyFish、AnySearch。总条数为 12，各引擎上限为 8，默认排除 `gitcode.com` 和 `csdn.com`。

覆盖示例：

```json
{
  "websearch": {
    "primary_providers": ["brave_api", "exa_api", "tavily", "exa_mcp"],
    "auxiliary_providers": ["tinyfish", "anysearch"],
    "default_results": 8,
    "exclude_domains": [],
    "exa_api": { "max_results": 5 }
  }
}
```

数组整体替换。GUI“网络与网页”可修改分组、组内顺序、条数和开关。

## 提供方

| 引擎 | 认证 | 行为 |
| --- | --- | --- |
| Brave | `BRAVE_SEARCH_API_KEY` | LLM Context 接口，保留 snippets |
| Exa API | `EXA_API_KEY` | `type: auto`，Dynamic Highlights |
| Tavily | `TAVILY_API_KEY` | `search_depth: basic` |
| Exa MCP | 免密钥 | 公共 MCP 的 `web_search_advanced_exa` |
| TinyFish | `TINYFISH_API_KEY` | 首页结果，本地限制条数 |
| AnySearch | 可选 `ANYSEARCH_API_KEY` | 有密钥时认证，否则匿名访问 |

`api_key` 接受明文、`$NAME` 或 `${NAME}`。需要密钥的引擎在凭据为空或无法解析时跳过。AnySearch 认证响应为 401、402、403 时，最多重试一次匿名请求，共用原超时预算。

提供方 endpoint 必须是公开 HTTP(S) 地址。搜索不跟随 3xx，也不发送网页 Cookie。Exa MCP 每次请求使用独立会话，初始化与搜索共用截止时间。

## 域名过滤

`include_domains` 和 `exclude_domains` 作为全局过滤，与查询中的 `site:` / `-site:` 合并。包含与排除域名不得重叠。

Brave 和 AnySearch 将域名条件重建为查询操作符，其他引擎使用结构化参数。

## 结果与错误

```xml
<websearch>
[1] Page title
https://example.com/page
Search result snippet.
</websearch>
```

摘要保留提供方返回的非空片段，按原顺序连接并去除完全重复片段。结果条数、超时和响应字节上限仍生效。需要页面正文时使用 `webfetch`。

`details` 保存查询、贡献结果的提供方和尝试记录。相同配置与凭据下的并发搜索可以合并，完成结果不缓存。

常见错误包括 `CONFIG_ERROR`、`NO_PROVIDER_AVAILABLE`、`RATE_LIMITED`、`QUOTA_EXHAUSTED`、`HTTP_ERROR`、`RESPONSE_TOO_LARGE`、`TIMEOUT` 和 `ABORTED`。

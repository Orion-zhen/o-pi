# 网页工具网络配置

两个网页工具共用 `web-tools.jsonc` 的 `network` 配置。默认值见 [`agent/defaults/web-tools.jsonc`](../../../agent/defaults/web-tools.jsonc)。

## 代理

```json
{
  "network": {
    "proxy": {
      "enabled": true,
      "http_proxy": "http://127.0.0.1:7890",
      "https_proxy": "http://127.0.0.1:7890",
      "socks5_proxy": ""
    }
  }
}
```

代理默认关闭，此时直连并忽略 `HTTP_PROXY`、`HTTPS_PROXY` 等环境变量。启用后至少填写一个端点。

| 目标 | 选择顺序 |
| --- | --- |
| HTTP | `http_proxy`、`socks5_proxy`、`https_proxy` |
| HTTPS | `https_proxy`、`socks5_proxy`、`http_proxy` |

HTTP 代理接受 `http://` 或 `https://`，SOCKS5 接受 `socks5://`。端点只含 origin，可包含认证信息。SOCKS5 使用 Undici 的实验性实现。

## 地址检查

直连和代理都先在本地解析目标 DNS。结果须全部为公网地址或配置允许的 fake-ip。通过代理时使用校验后的 IP，并保留 Host 和 TLS SNI。

`network.fake_ip_ranges` 只接受 `198.18.0.0/15` 内的子网，用于域名解析结果。URL 直接填写该地址仍会被拒绝。

`webfetch` 的私网访问通过[审批模块](../approval-gate/README.md)授权。授权绑定完整 origin 和当次解析地址，每次调用重新解析，重定向与主图下载各自检查。关闭审批模块后，工具仍执行地址检查。

`websearch` 的 endpoint 只允许公网目标，3xx 作为错误处理。

## Cookie

Cookie 供 `webfetch` 使用，默认文件为 `~/.pi/agent/cookies.txt`，可用 `PI_WEB_TOOLS_COOKIES` 指定路径。文件采用 Netscape/Mozilla 格式。Unix 下限制权限：

```bash
chmod 600 ~/.pi/agent/cookies.txt
```

发送 Cookie 需满足：

1. `webfetch.cookies.enabled` 为 true。
2. 目标主机未命中 `webfetch.cookies.blacklist` 黑名单。
3. Cookie 自身的 domain、path、secure 和 expiry 匹配。

`example.com` 匹配该主机，`*.example.com` 匹配子域名。

默认启用 Cookie，黑名单为空。每次请求（包括重定向）自动附带匹配的 Cookie，不询问确认。文件不存在或没有匹配的 Cookie 时不附带。

响应的 `Set-Cookie` 只更新内存 CookieJar。Cookie 名称和值不会进入模型结果和错误展示。

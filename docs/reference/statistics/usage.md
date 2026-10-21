# 用量与余额

```text
/usage
/usage refresh
```

TUI 使用浮层，GUI 使用用量面板，RPC 通过通知返回文本。

## 提供方

| 提供方 | 凭据与内容 |
| --- | --- |
| Claude `anthropic` | OAuth 套餐窗口 |
| Codex `openai-codex` | OAuth 套餐窗口与累积重置额度 |
| Kimi Code `kimi-coding` | OAuth 套餐窗口 |
| Grok `xai` | OAuth 套餐窗口 |
| DeepSeek `deepseek` | API key 对应的官方余额 |

凭据通过 SDK `getProviderAuth()` 获取，未配置项隐藏。DeepSeek 可使用 `DEEPSEEK_API_KEY`，金额保留原币种与精度。

Codex 直接使用 Pi OAuth 请求，额度详情失败时保留已有窗口信息。

## 查询

各提供方并发查询，单家失败在对应区域显示脱敏错误。结果缓存 60 秒，refresh 绕过已完成缓存，并发调用共享在途请求。

GUI 刷新时保留当前内容，结束后替换快照。凭据和响应正文不写入会话历史或模型上下文。

套餐接口按当前第一方字段解析，接口变化时对应区域报告失败。DeepSeek 使用[公开余额接口](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/)。

`UsageService.load()` 返回序列化快照，时间使用 ISO 8601 字符串。

# 词元估算

`src/harness/token-counter.ts` 用于 harness 的上下文组成部分的估算、裁剪成本预览、grep 输出观测和子代理结果预算。

提供方已返回 `usage` 时优先使用该值。估算项在界面中使用 `~` 标记。

## 接口

```ts
countTextTokens(text, scope)
countContentTokens(content, scope)
countTextTokensSync(text, scope)
isLocalOrPrivateHttpUrl(baseUrl)
```

`scope` 可包含 `provider`、`modelId` 和 `baseUrl`。模型编码按 `modelId` 匹配，不根据提供方名称或兼容协议推断。

异步计数保留本机或私网服务的 `/tokenize`、`/v1/tokenize` 探测，单次超时 350ms。该地址全部失败后，在当前进程中标记不可用，再使用本地计数。公网地址直接使用本地计数。

同步计数不触发网络请求，与异步入口共用本地规则。grep 输出和子代理结果按消费输出的模型计数。

## 本地计数

复用 `gpt-tokenizer` 自带的模型映射与编码数据。BPE 模块首次使用时加载，后续复用，不额外下载词表或模型权重。

| 模型或来源 | 方法 | 置信度 |
| --- | --- | --- |
| 本机或私网计数服务 | 服务返回值 | high |
| 库中已知的 GPT-4o、GPT-4.1、GPT-5、o 系列等 | `o200k_base` | high |
| 库中已知的 GPT-4、GPT-3.5 等 | `cl100k_base` | high |
| 库中已知的 GPT-OSS | `o200k_harmony` | high |
| 其他模型，包括 Qwen、DeepSeek、Kimi、GLM | `o200k_base` 近似 | low |

支持从带提供方前缀、路由后缀或 `ft:` 微调前缀的模型 ID 中提取基础模型名。空字符串计为零，空白字符保留。文本中的特殊 token 标记按字面内容计数，不解析为协议控制符。图片沿用每张 1200 token 的低置信度估算。

允许自动请求计数服务的地址为 localhost、`127.0.0.0/8`、RFC 1918 私网、`169.254.0.0/16`、`::1`、`fc00::/7` 和 `fe80::/10`。

## 返回值

结果包含 `tokens`、`confidence`、`method` 和 `note`。文本方法为 `remote_tokenize`、`o200k_base`、`cl100k_base` 或 `o200k_harmony`，内容块合计使用 `content_estimate`。

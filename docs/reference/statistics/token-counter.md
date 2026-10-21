# 词元估算

`src/harness/token-counter.ts` 提供统一计数，用于系统提示词、上下文分项、find 输出预算、grep 输出观测和子代理结果预算。

提供方已返回 `usage` 时优先使用该值。估算项在界面中使用 `~` 标记。

## 接口

```ts
countTextTokens(text, scope)
countContentTokens(content, scope)
countTextTokensSync(text, scope)
isLocalOrPrivateHttpUrl(baseUrl)
```

`scope` 可包含 `provider`、`modelId` 和 `baseUrl`。

异步计数先为本机或私网服务尝试 `/tokenize`、`/v1/tokenize`，单次超时 350ms。该地址全部失败后，在当前进程中标记不可用，再使用本地规则。公网地址直接使用本地估算。

同步计数用于工具预算，只使用本地规则。BPE 模块首次使用时加载，后续复用。

## 方法

| 模型或来源 | 方法 | 置信度 |
| --- | --- | --- |
| 本机或私网 tokenizer | 服务返回值 | high |
| OpenAI、兼容模型、`gpt-*`、`o*` | `o200k_base` | high |
| Qwen、DashScope、Alibaba | `cl100k_base` | medium |
| Kimi、Moonshot、Z.ai | `cl100k_base` | medium |
| DeepSeek | 字符比例 | medium |
| 异步未知模型 | 字符数除以 4 | low |
| 同步未知模型 | `o200k_base` | low |

DeepSeek 每个中文字符按 0.6 token，英文或数字 0.3，空白 0.15，其他字符 0.5 估算。

允许自动请求 tokenizer 的地址为 localhost、`127.0.0.0/8`、RFC 1918 私网、`169.254.0.0/16`、`::1`、`fc00::/7` 和 `fe80::/10`。

## 返回值

结果包含 `tokens`、`confidence`、`method` 和 `note`。方法为 `remote_tokenize`、`o200k_base`、`cl100k_base`、`deepseek_ratio` 或 `char_ratio`。

计数用于预算和展示，实际用量与费用以提供方响应和账单为准。

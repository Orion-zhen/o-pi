# Token Counter

`src/token-counter.ts` 是本仓库统一的 token 计数入口。它用于：

* `/stats` 的 context breakdown 分项估算；
* `find` / `grep` 模型可见输出预算；
* 测试中验证输出是否落在 token budget 内。

## 原则

* provider 已返回 usage 时，展示层优先使用 usage；counter 只估算缺失的拆分项。
* 不把单一 tokenizer 当作所有模型的真值。
* 不自动请求公网 provider 的 tokenize/count endpoint，避免未知计费或限流副作用。
* 只对本机或私网 `baseUrl` 自动尝试 tokenizer endpoint。
* 所有非 usage 来源的数值都视为估算，UI 使用 `~` 标记。

## 入口

```ts
countTextTokens(text, scope)
countContentTokens(content, scope)
countTextTokensSync(text, scope)
isLocalOrPrivateHttpUrl(baseUrl)
```

`scope` 可包含：

```ts
{
	provider?: string;
	modelId?: string;
	baseUrl?: string;
}
```

## 异步计数

`countTextTokens()` 用于 `/stats` 这类可以接受短暂异步等待的路径。

顺序：

1. 如果 `baseUrl` 是本机或私网地址，尝试 tokenizer endpoint。
2. 按 provider/model 选择本地 tokenizer 或估算规则。
3. 失败时退回保守 fallback。

本地/私网 endpoint：

```text
/tokenize
/v1/tokenize
```

请求超时为 350ms。某个 `baseUrl` 全部失败后，会在进程内记为不可用，后续不再重复等待。

允许自动请求的地址：

```text
localhost
127.0.0.0/8
10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
169.254.0.0/16
::1
fc00::/7
fe80::/10
```

公网 provider，如 `api.openai.com`、`api.deepseek.com`、DashScope 等，不会被自动请求。

## 同步计数

`countTextTokensSync()` 用于工具输出预算，不能发网络请求。

顺序：

1. 已知模型族使用对应本地 tokenizer 或规则。
2. 未知模型族使用 `o200k_base` 做通用 BPE 预算估算，并标记低置信度。

## 模型族规则

| 匹配 | 方法 | 置信度 |
| --- | --- | --- |
| 本地/私网 `/tokenize` 成功 | remote tokenizer | high |
| OpenAI / OpenAI-compatible / `gpt-*` / `o*` | `o200k_base` | high |
| Qwen / DashScope / Alibaba | `cl100k_base` | medium |
| Kimi / Moonshot / Z.ai | `cl100k_base` | medium |
| DeepSeek | 官方字符比例估算 | medium |
| 异步未知 fallback | `chars / 4` | low |
| 同步未知 fallback | `o200k_base` | low |

DeepSeek 字符比例：

```text
中文字符 0.6 token
英文/数字 0.3 token
空白 0.15 token
其他字符 0.5 token
```

## 结果字段

```ts
{
	tokens: number;
	confidence: "exact" | "high" | "medium" | "low";
	method:
		| "remote_tokenize"
		| "o200k_base"
		| "cl100k_base"
		| "deepseek_ratio"
		| "char_ratio";
	note: string;
}
```

当前 `exact` 预留给未来官方免费 count API 接入；现有 counter 不主动把非 usage 结果标为 exact。

## 计费边界

已确认：

* 自部署 vLLM / llama.cpp 的 tokenizer endpoint 是本地服务调用，不产生第三方 provider 账单。
* AWS Bedrock `CountTokens` 官方文档说明不收费，但本仓库当前没有自动调用 AWS。

未默认调用：

* Anthropic `count_tokens`；
* DeepSeek、DashScope、OpenAI-compatible 公网 `/tokenize`；
* 任意公网自定义 provider 的 token endpoint。

如以后需要接入公网免费 count API，必须新增显式 allowlist 和 provider-specific 请求格式，不能通过泛化 `/v1/tokenize` 自动探测。

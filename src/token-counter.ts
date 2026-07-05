import net from "node:net";
import { countTokens as countCl100kTokens } from "gpt-tokenizer/encoding/cl100k_base";
import { countTokens as countO200kTokens } from "gpt-tokenizer/encoding/o200k_base";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

const REMOTE_TIMEOUT_MS = 350;
const ESTIMATED_IMAGE_TOKENS = 1200;
const remoteCache = new Map<string, TokenCount>();
const unavailableRemoteBases = new Set<string>();

export type TokenCounterConfidence = "exact" | "high" | "medium" | "low";

export interface TokenCounterScope {
	provider?: string;
	modelId?: string;
	baseUrl?: string;
}

export interface TokenCount {
	tokens: number;
	confidence: TokenCounterConfidence;
	method: "remote_tokenize" | "o200k_base" | "cl100k_base" | "deepseek_ratio" | "char_ratio";
	note: string;
}

/** provider-aware token 计数；优先本地 tokenizer endpoint，其次模型族 tokenizer，最后保守字符估算。 */
export async function countTextTokens(text: string, scope: TokenCounterScope = {}): Promise<TokenCount> {
	if (text.trim().length === 0) return { tokens: 0, confidence: "high", method: "char_ratio", note: "empty text" };

	const remote = await countWithLocalTokenizer(text, scope);
	if (remote !== undefined) return remote;

	const family = detectTokenizerFamily(scope);
	if (family === "o200k") return countWithBpe(text, "o200k_base", countO200kTokens, "OpenAI-compatible BPE tokenizer");
	if (family === "cl100k") return countWithBpe(text, "cl100k_base", countCl100kTokens, "cl100k-compatible BPE tokenizer");
	if (family === "deepseek_ratio") return countWithDeepSeekRatio(text);
	return countWithCharRatio(text, "unknown tokenizer fallback");
}

/** 同步模型可见文本计数；用于工具输出预算，不触发任何网络请求。 */
export function countTextTokensSync(text: string, scope: TokenCounterScope = {}): TokenCount {
	if (text.trim().length === 0) return { tokens: 0, confidence: "high", method: "char_ratio", note: "empty text" };
	const family = detectTokenizerFamily(scope);
	if (family === "o200k") return countWithBpe(text, "o200k_base", countO200kTokens, "OpenAI-compatible BPE tokenizer");
	if (family === "cl100k") return countWithBpe(text, "cl100k_base", countCl100kTokens, "cl100k-compatible BPE tokenizer");
	if (family === "deepseek_ratio") return countWithDeepSeekRatio(text);
	// Unknown model families still use o200k as a stronger budget estimator than chars/4, but keep confidence low.
	const counted = countWithBpe(text, "o200k_base", countO200kTokens, "generic BPE budget estimate");
	return { ...counted, confidence: "low", note: "generic BPE budget estimate" };
}

export async function countContentTokens(content: string | Array<TextContent | ImageContent>, scope: TokenCounterScope = {}): Promise<TokenCount> {
	if (typeof content === "string") return countTextTokens(content, scope);
	let total = 0;
	let confidence: TokenCounterConfidence = "high";
	const notes = new Set<string>();
	for (const part of content) {
		if (part.type === "image") {
			total += ESTIMATED_IMAGE_TOKENS;
			confidence = minConfidence(confidence, "low");
			notes.add("image estimate");
			continue;
		}
		const counted = await countTextTokens(part.text, scope);
		total += counted.tokens;
		confidence = minConfidence(confidence, counted.confidence);
		notes.add(counted.note);
	}
	return { tokens: total, confidence, method: "char_ratio", note: [...notes].join("; ") || "content estimate" };
}

function countWithBpe(text: string, method: "o200k_base" | "cl100k_base", count: (input: string) => number, note: string): TokenCount {
	try {
		return { tokens: count(text), confidence: method === "o200k_base" ? "high" : "medium", method, note };
	} catch {
		return countWithCharRatio(text, `${method} failed`);
	}
}

function countWithDeepSeekRatio(text: string): TokenCount {
	let tokens = 0;
	for (const char of text) {
		if (/\p{Script=Han}/u.test(char)) tokens += 0.6;
		else if (/[A-Za-z0-9]/.test(char)) tokens += 0.3;
		else if (/\s/.test(char)) tokens += 0.15;
		else tokens += 0.5;
	}
	return {
		tokens: Math.max(1, Math.ceil(tokens)),
		confidence: "medium",
		method: "deepseek_ratio",
		note: "DeepSeek published character ratio estimate",
	};
}

function countWithCharRatio(text: string, note: string): TokenCount {
	return {
		tokens: Math.max(1, Math.ceil([...text.trim()].length / 4)),
		confidence: "low",
		method: "char_ratio",
		note,
	};
}

type TokenizerFamily = "o200k" | "cl100k" | "deepseek_ratio" | "char_ratio";

function detectTokenizerFamily(scope: TokenCounterScope): TokenizerFamily {
	const provider = normalize(scope.provider);
	const model = normalize(scope.modelId);
	const combined = `${provider} ${model}`;
	if (/\b(openai|openai-codex)\b/.test(provider) || /\b(gpt|o[1345])[-\w.]*/.test(model)) return "o200k";
	if (combined.includes("deepseek")) return "deepseek_ratio";
	if (combined.includes("qwen") || combined.includes("dashscope") || combined.includes("alibaba")) return "cl100k";
	if (combined.includes("kimi") || combined.includes("moonshot") || combined.includes("zai")) return "cl100k";
	return "char_ratio";
}

function normalize(value: string | undefined): string {
	return (value ?? "").toLowerCase();
}

async function countWithLocalTokenizer(text: string, scope: TokenCounterScope): Promise<TokenCount | undefined> {
	if (!isLocalOrPrivateHttpUrl(scope.baseUrl)) return undefined;
	const baseUrl = normalizeTokenizerBaseUrl(scope.baseUrl);
	if (baseUrl === undefined) return undefined;
	if (unavailableRemoteBases.has(baseUrl)) return undefined;
	const cacheKey = `${baseUrl}\n${scope.modelId ?? ""}\n${text}`;
	const cached = remoteCache.get(cacheKey);
	if (cached !== undefined) return cached;

	for (const request of localTokenizerRequests(baseUrl, text, scope.modelId)) {
		const tokens = await postTokenize(request.url, request.body);
		if (tokens === undefined) continue;
		const counted: TokenCount = {
			tokens,
			confidence: "high",
			method: "remote_tokenize",
			note: `local tokenizer ${request.kind}`,
		};
		remoteCache.set(cacheKey, counted);
		return counted;
	}
	unavailableRemoteBases.add(baseUrl);
	return undefined;
}

function localTokenizerRequests(baseUrl: string, text: string, modelId: string | undefined): Array<{ kind: string; url: string; body: Record<string, unknown> }> {
	return [
		{ kind: "llama.cpp", url: `${baseUrl}/tokenize`, body: { content: text, add_special: false, parse_special: true } },
		{ kind: "vLLM", url: `${baseUrl}/tokenize`, body: { model: modelId, prompt: text, add_special_tokens: false } },
		{ kind: "OpenAI-compatible", url: `${baseUrl}/v1/tokenize`, body: { model: modelId, input: text, prompt: text, content: text } },
	];
}

async function postTokenize(url: string, body: Record<string, unknown>): Promise<number | undefined> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!response.ok) return undefined;
		return parseTokenizeResponse(await response.json());
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

function parseTokenizeResponse(value: unknown): number | undefined {
	if (!isRecord(value)) return undefined;
	const tokens = value["tokens"];
	if (Array.isArray(tokens)) return tokens.length;
	for (const key of ["input_tokens", "token_count", "count", "num_tokens", "length"]) {
		const count = value[key];
		if (typeof count === "number" && Number.isFinite(count) && count >= 0) return count;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizeTokenizerBaseUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (url.pathname.endsWith("/v1")) url.pathname = url.pathname.slice(0, -3) || "/";
		url.pathname = url.pathname.replace(/\/+$/, "");
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/$/, "");
	} catch {
		return undefined;
	}
}

/** 只允许本机/私网 tokenizer，避免向公网计费 provider 发送额外请求。 */
export function isLocalOrPrivateHttpUrl(value: string | undefined): boolean {
	if (!value) return false;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		const host = url.hostname.toLowerCase();
		if (host === "localhost" || host.endsWith(".localhost")) return true;
		const ipVersion = net.isIP(host);
		if (ipVersion === 4) return isPrivateIpv4(host);
		if (ipVersion === 6) return isPrivateIpv6(host);
		return false;
	} catch {
		return false;
	}
}

function isPrivateIpv4(host: string): boolean {
	const parts = host.split(".").map(Number);
	const [a, b] = parts;
	if (a === undefined || b === undefined) return false;
	return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function isPrivateIpv6(host: string): boolean {
	return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}

const confidenceRank: Record<TokenCounterConfidence, number> = {
	exact: 4,
	high: 3,
	medium: 2,
	low: 1,
};

function minConfidence(left: TokenCounterConfidence, right: TokenCounterConfidence): TokenCounterConfidence {
	return confidenceRank[left] <= confidenceRank[right] ? left : right;
}

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { chatModelParams, DEFAULT_ENCODING, modelToEncodingMap } from "gpt-tokenizer/mapping";
import ipaddr from "ipaddr.js";

const REMOTE_TIMEOUT_MS = 350;
const ESTIMATED_IMAGE_TOKENS = 1200;
export const REMOTE_TOKEN_CACHE_MAX_ENTRIES = 128;
const remoteCache = new Map<string, TokenCount>();
const unavailableRemoteBases = new Set<string>();
const require = createRequire(import.meta.url);

type BpeMethod = "o200k_base" | "cl100k_base" | "o200k_harmony";
type BpeCounter = typeof import("gpt-tokenizer/encoding/o200k_base").countTokens;
const modelEncodings: Readonly<Record<string, string | undefined>> = modelToEncodingMap;
const literalTextOptions = { disallowedSpecial: new Set<string>() };
interface BpeState {
	counter: BpeCounter | undefined;
	load: Promise<BpeCounter> | undefined;
}

const bpeStates: Record<BpeMethod, BpeState> = {
	o200k_base: { counter: undefined, load: undefined },
	cl100k_base: { counter: undefined, load: undefined },
	o200k_harmony: { counter: undefined, load: undefined },
};

export type TokenCounterConfidence = "exact" | "high" | "medium" | "low";

export interface TokenCounterScope {
	provider?: string;
	modelId?: string;
	baseUrl?: string;
}

export interface TokenCount {
	tokens: number;
	confidence: TokenCounterConfidence;
	method: BpeMethod | "remote_tokenize" | "content_estimate";
	note: string;
}

interface BpeProfile {
	method: BpeMethod;
	confidence: TokenCounterConfidence;
	note: string;
}

/** 优先使用本机或私网计数服务，本地计数与同步入口共用模型规则。 */
export async function countTextTokens(text: string, scope: TokenCounterScope = {}): Promise<TokenCount> {
	const profile = resolveBpeProfile(scope);
	if (text.length === 0) return { ...profile, tokens: 0, confidence: "exact" };

	const remote = await countWithLocalTokenizer(text, scope);
	if (remote !== undefined) return remote;

	return bpeResult(text, profile, await loadBpeCounter(profile.method));
}

/** 同步计算模型可见文本，用于工具输出预算，不触发网络请求。 */
export function countTextTokensSync(text: string, scope: TokenCounterScope = {}): TokenCount {
	const profile = resolveBpeProfile(scope);
	if (text.length === 0) return { ...profile, tokens: 0, confidence: "exact" };
	return bpeResult(text, profile, loadBpeCounterSync(profile.method));
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
	return { tokens: total, confidence, method: "content_estimate", note: [...notes].join("; ") || "content estimate" };
}

function bpeResult(text: string, profile: BpeProfile, count: BpeCounter): TokenCount {
	// 文件和工具输出中的特殊 token 标记是普通文本，不作为协议控制符解析。
	return { ...profile, tokens: count(text, literalTextOptions) };
}

function loadBpeCounter(method: BpeMethod): Promise<BpeCounter> {
	const state = bpeStates[method];
	if (state.counter !== undefined) return Promise.resolve(state.counter);
	if (state.load !== undefined) return state.load;

	const created = (method === "o200k_base"
		? import("gpt-tokenizer/encoding/o200k_base")
		: method === "cl100k_base"
			? import("gpt-tokenizer/encoding/cl100k_base")
			: import("gpt-tokenizer/encoding/o200k_harmony"))
		.then((module) => {
			const counter = requireBpeCounter(module);
			state.counter = counter;
			return counter;
		})
		.catch((error: unknown) => {
			state.load = undefined;
			throw error;
		});
	state.load = created;
	return created;
}

function loadBpeCounterSync(method: BpeMethod): BpeCounter {
	const state = bpeStates[method];
	if (state.counter !== undefined) return state.counter;
	const counter = requireBpeCounter(method === "o200k_base"
		? require("gpt-tokenizer/encoding/o200k_base")
		: method === "cl100k_base"
			? require("gpt-tokenizer/encoding/cl100k_base")
			: require("gpt-tokenizer/encoding/o200k_harmony"));
	state.counter = counter;
	return counter;
}

function requireBpeCounter(module: unknown): BpeCounter {
	if (!isBpeModule(module)) {
		throw new Error("gpt-tokenizer module does not export countTokens");
	}
	return module.countTokens;
}

function isBpeModule(value: unknown): value is { countTokens: BpeCounter } {
	return typeof value === "object" && value !== null && "countTokens" in value && typeof value.countTokens === "function";
}

function resolveBpeProfile(scope: TokenCounterScope): BpeProfile {
	const modelId = scope.modelId?.toLowerCase().split("/").at(-1) ?? "";
	const model = modelId.split(":")[modelId.startsWith("ft:") ? 1 : 0] ?? "";
	// 库的编码表只列出覆盖项，已知聊天模型未列出时使用库的默认编码。
	const method = modelEncodings[model] ?? (Object.hasOwn(chatModelParams, model) ? DEFAULT_ENCODING : undefined);
	if (method === "o200k_base" || method === "cl100k_base" || method === "o200k_harmony") {
		return { method, confidence: "high", note: "model BPE tokenizer" };
	}
	return { method: "o200k_base", confidence: "low", note: "generic BPE estimate" };
}

async function countWithLocalTokenizer(text: string, scope: TokenCounterScope): Promise<TokenCount | undefined> {
	if (!isLocalOrPrivateHttpUrl(scope.baseUrl)) return undefined;
	const baseUrl = normalizeTokenizerBaseUrl(scope.baseUrl);
	if (baseUrl === undefined) return undefined;
	if (unavailableRemoteBases.has(baseUrl)) return undefined;
	const cacheKey = createHash("sha256").update(baseUrl).update("\0").update(scope.modelId ?? "").update("\0").update(text).digest("hex");
	const cached = remoteCache.get(cacheKey);
	if (cached !== undefined) {
		remoteCache.delete(cacheKey);
		remoteCache.set(cacheKey, cached);
		return cached;
	}

	for (const request of localTokenizerRequests(baseUrl, text, scope.modelId)) {
		const tokens = await postTokenize(request.url, request.body);
		if (tokens === undefined) continue;
		const counted: TokenCount = {
			tokens,
			confidence: "high",
			method: "remote_tokenize",
			note: `local tokenizer ${request.kind}`,
		};
		setRemoteCache(cacheKey, counted);
		return counted;
	}
	unavailableRemoteBases.add(baseUrl);
	return undefined;
}

function setRemoteCache(key: string, value: TokenCount): void {
	remoteCache.set(key, value);
	while (remoteCache.size > REMOTE_TOKEN_CACHE_MAX_ENTRIES) {
		const oldest = remoteCache.keys().next().value;
		if (oldest === undefined) return;
		remoteCache.delete(oldest);
	}
}

function localTokenizerRequests(baseUrl: string, text: string, modelId: string | undefined): Array<{ kind: string; url: string; body: Record<string, unknown> }> {
	return [
		{ kind: "llama.cpp", url: `${baseUrl}/tokenize`, body: { content: text, add_special: false, parse_special: false } },
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
		const host = url.hostname.replace(/^\[|\]$/g, "");
		if (host === "localhost" || host.endsWith(".localhost")) return true;
		const range = ipaddr.parse(host).range();
		return range === "loopback" || range === "private" || range === "linkLocal" || range === "uniqueLocal";
	} catch {
		return false;
	}
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

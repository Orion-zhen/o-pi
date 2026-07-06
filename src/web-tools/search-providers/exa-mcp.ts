import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { normalizeSearchText } from "../duckduckgo-html.js";
import type { WebSearchErrorCode, WebSearchFailureDetails, WebSearchItem, WebToolsConfig } from "../types.js";
import type { NormalizedSearchParams, SearchProviderContext, SearchProviderResult, WebSearchProvider } from "./types.js";

const TRACKING_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];
const MAX_TITLE_CHARS = 300;
const MAX_SNIPPET_CHARS = 500;

/** Exa MCP client 的最小可替换接口；单测通过 fake client 避免真实网络。 */
export interface ExaMcpClient {
	callTool(args: { name: string; arguments: Record<string, unknown> }, options?: { signal?: AbortSignal; timeout?: number }): Promise<unknown>;
	close(): Promise<void>;
}

/** Exa MCP 连接工厂；默认实现使用官方 Streamable HTTP transport。 */
export interface ExaMcpClientFactory {
	connect(config: WebToolsConfig["websearch"]["exa_mcp"], signal?: AbortSignal): Promise<ExaMcpClient>;
}

/** 默认 Exa hosted MCP client factory；API key 仅从环境变量注入请求头。 */
export class DefaultExaMcpClientFactory implements ExaMcpClientFactory {
	async connect(config: WebToolsConfig["websearch"]["exa_mcp"], signal?: AbortSignal): Promise<ExaMcpClient> {
		const headers = apiKeyHeaders(config);
		const transport = new StreamableHTTPClientTransport(new URL(config.url), {
			...(headers !== undefined ? { requestInit: { headers } } : {}),
		});
		const client = new Client({ name: "o-pi-websearch", version: "0.1.0" });
		await client.connect(asClientTransport(transport), signal !== undefined ? { signal, timeout: config.timeout_seconds * 1000 } : { timeout: config.timeout_seconds * 1000 });
		return {
			async callTool(args, options) {
				return client.callTool(args, undefined, options);
			},
			async close() {
				await client.close();
				await transport.close();
			},
		};
	}
}

/** 创建 Exa MCP provider；连接失败和调用失败都交给 router fallback。 */
export function createExaMcpProvider(config: WebToolsConfig["websearch"]["exa_mcp"], factory: ExaMcpClientFactory = new DefaultExaMcpClientFactory()): WebSearchProvider {
	let client: ExaMcpClient | undefined;

	async function closeClient(): Promise<void> {
		const current = client;
		client = undefined;
		await current?.close();
	}

	async function connected(signal?: AbortSignal): Promise<ExaMcpClient> {
		if (client !== undefined) return client;
		client = await factory.connect(config, signal);
		return client;
	}

	return {
		id: "exa_mcp",
		async search(params: NormalizedSearchParams, context: SearchProviderContext): Promise<SearchProviderResult> {
			if (!config.enabled) return { status: "skipped", provider: "exa_mcp", reason: "provider disabled" };
			const timeout = AbortSignal.timeout(config.timeout_seconds * 1000);
			const signal = AbortSignal.any([context.signal ?? new AbortController().signal, timeout]);
			try {
				const active = await connected(signal);
				const raw = await active.callTool(
					{
						name: config.tool,
						arguments: {
							query: params.query,
							numResults: params.limit,
							type: config.type,
						},
					},
					{ signal, timeout: config.timeout_seconds * 1000 },
				);
				const normalized = normalizeExaMcpResult(raw, params.limit);
				if (normalized.length === 0) {
					return failed("PARSE_FAILED", "Exa MCP search response did not contain usable result URLs.", params.query);
				}
				return { status: "success", provider: "exa_mcp", results: normalized, downloadedBytes: 0 };
			} catch (error) {
				if (signal.aborted) await closeClient();
				return failed(errorCode(error, context.signal, timeout), sanitizeMcpMessage(errorMessage(error), config), params.query);
			}
		},
		close: closeClient,
	};
}

/** 从配置指定的环境变量读取 API key，并转换为 hosted MCP 需要的请求头。 */
export function apiKeyHeaders(config: WebToolsConfig["websearch"]["exa_mcp"]): Record<string, string> | undefined {
	const key = process.env[config.api_key_env]?.trim();
	return key ? { "x-api-key": key } : undefined;
}

/** 将 Exa MCP 常见返回形态归一化为模型可消费的短搜索结果。 */
export function normalizeExaMcpResult(raw: unknown, limit: number): WebSearchItem[] {
	const candidates = collectCandidates(raw);
	const seen = new Set<string>();
	const results: WebSearchItem[] = [];
	for (const candidate of candidates) {
		const url = normalizeResultUrl(candidate.url);
		if (url === undefined || seen.has(url)) continue;
		seen.add(url);
		const title = normalizeSearchText(candidate.title ?? url).slice(0, MAX_TITLE_CHARS);
		const snippet = normalizeSearchText(candidate.snippet ?? "").slice(0, MAX_SNIPPET_CHARS);
		results.push({
			rank: results.length + 1,
			title: title.length > 0 ? title : url,
			url,
			...(snippet.length > 0 ? { snippet } : {}),
		});
		if (results.length >= limit) break;
	}
	return results;
}

function collectCandidates(value: unknown): Array<{ title?: string; url?: string; snippet?: string }> {
	const direct = collectObjectCandidates(value);
	if (direct.length > 0) return direct;
	const text = collectText(value);
	return collectTextCandidates(text);
}

function collectObjectCandidates(value: unknown): Array<{ title?: string; url?: string; snippet?: string }> {
	if (!isRecord(value)) return [];
	const roots = [value["structuredContent"], value];
	const candidates: Array<{ title?: string; url?: string; snippet?: string }> = [];
	for (const root of roots) {
		const rows = resultRows(root);
		for (const row of rows) {
			if (!isRecord(row)) continue;
			const title = firstString(row, ["title", "name"]);
			const url = firstString(row, ["url", "link"]);
			const snippet = firstString(row, ["snippet", "text", "summary", "content"]);
			if (url !== undefined) candidates.push(candidate(title, url, snippet));
		}
	}
	return candidates;
}

function resultRows(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (!isRecord(value)) return [];
	const results = value["results"];
	if (Array.isArray(results)) return results;
	const data = value["data"];
	if (Array.isArray(data)) return data;
	return [];
}

function collectText(value: unknown): string {
	if (!isRecord(value)) return "";
	const content = value["content"];
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string" ? block["text"] : ""))
		.filter((text) => text.length > 0)
		.join("\n");
}

function collectTextCandidates(text: string): Array<{ title?: string; url?: string; snippet?: string }> {
	const parsed = parseJsonText(text);
	if (parsed !== undefined) {
		const fromJson = collectObjectCandidates(parsed);
		if (fromJson.length > 0) return fromJson;
	}
	const candidates: Array<{ title?: string; url?: string; snippet?: string }> = [];
	const markdown = /\[([^\]]{1,300})\]\((https?:\/\/[^)\s]+)\)/g;
	for (const match of text.matchAll(markdown)) {
		candidates.push(candidate(match[1], match[2]));
	}
	const urls = /https?:\/\/[^\s<>)"']+/g;
	for (const match of text.matchAll(urls)) {
		candidates.push(candidate(undefined, match[0]));
	}
	return candidates;
}

function parseJsonText(text: string): unknown | undefined {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function normalizeResultUrl(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	if (url.username !== "" || url.password !== "") return undefined;
	url.hash = "";
	for (const name of TRACKING_PARAMS) url.searchParams.delete(name);
	return url.toString();
}

function candidate(title: string | undefined, url: string | undefined, snippet?: string): { title?: string; url?: string; snippet?: string } {
	return {
		...(title !== undefined ? { title } : {}),
		...(url !== undefined ? { url } : {}),
		...(snippet !== undefined ? { snippet } : {}),
	};
}

function asClientTransport(transport: StreamableHTTPClientTransport): Transport {
	return new ClientTransportAdapter(transport);
}

class ClientTransportAdapter implements Transport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: <T extends JSONRPCMessage>(message: T) => void;

	constructor(private readonly transport: StreamableHTTPClientTransport) {}

	async start(): Promise<void> {
		this.installHandlers();
		await this.transport.start();
	}

	async send(message: JSONRPCMessage): Promise<void> {
		await this.transport.send(message);
	}

	async close(): Promise<void> {
		await this.transport.close();
	}

	setProtocolVersion(version: string): void {
		this.transport.setProtocolVersion(version);
	}

	private installHandlers(): void {
		if (this.onclose === undefined) delete this.transport.onclose;
		else this.transport.onclose = this.onclose;
		if (this.onerror === undefined) delete this.transport.onerror;
		else this.transport.onerror = this.onerror;
		if (this.onmessage === undefined) delete this.transport.onmessage;
		else this.transport.onmessage = (message) => this.onmessage?.(message);
	}
}

function failed(code: WebSearchErrorCode, message: string, query: string): SearchProviderResult {
	const details: WebSearchFailureDetails = {
		status: "failed",
		error: { code, message },
		query,
		provider: "exa_mcp",
	};
	return { status: "failed", provider: "exa_mcp", details };
}

function errorCode(error: unknown, userSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): WebSearchErrorCode {
	if (userSignal?.aborted) return "ABORTED";
	if (timeoutSignal.aborted) return "TIMEOUT";
	if (error instanceof DOMException && error.name === "AbortError") return "ABORTED";
	if (error instanceof DOMException && error.name === "TimeoutError") return "TIMEOUT";
	return "MCP_ERROR";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sanitizeMcpMessage(message: string, config: WebToolsConfig["websearch"]["exa_mcp"]): string {
	let sanitized = message;
	const key = process.env[config.api_key_env]?.trim();
	if (key) sanitized = sanitized.split(key).join("REDACTED");
	return sanitized.replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
		try {
			const url = new URL(raw);
			url.search = "";
			url.hash = "";
			return url.toString();
		} catch {
			return "REDACTED_URL";
		}
	});
}

function firstString(row: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = row[key];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

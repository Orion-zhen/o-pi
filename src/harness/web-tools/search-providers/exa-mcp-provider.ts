import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Dispatcher } from "undici";

import type { WebToolsConfig } from "../config-types.ts";
import type { WebSearchErrorCode } from "../core/types.ts";
import { classifyNetworkError } from "../network/errors.ts";
import type { WebHttpFetch } from "../network/types.ts";
import { classifyHttpStatus, normalizeProviderResponse } from "./api-provider.ts";
import { createExaMcpFetch, ExaMcpHttpError } from "./exa-mcp-http.ts";
import type { NormalizedSearchParams, SearchProviderContext, SearchProviderResult } from "./types.ts";

export async function searchExaMcp(options: {
	config: WebToolsConfig["websearch"]["exa_mcp"];
	dispatcher: () => Promise<Dispatcher>;
	fetchImpl: WebHttpFetch;
}, params: NormalizedSearchParams, context: SearchProviderContext): Promise<SearchProviderResult> {
	const { config } = options;
	const remaining = (context.deadlineAt ?? Number.POSITIVE_INFINITY) - context.now();
	if (remaining <= 0) return failed(params.query, "TIMEOUT", "websearch deadline exceeded.");
	const timeout = AbortSignal.timeout(Math.min(config.timeout_seconds * 1000, remaining));
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, timeout, ...(context.signal === undefined ? [] : [context.signal])]);
	let downloadedBytes = 0;
	let closing = false;
	const endpoint = new URL(config.endpoint);
	endpoint.searchParams.set("tools", "web_search_advanced_exa");
	const transport = new StreamableHTTPClientTransport(endpoint, {
		// 重定向交给适配层，适配层始终使用 manual，不跟随跳转。
		redirectPolicy: "follow",
		reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
		fetch: createExaMcpFetch({
			...options, signal, maxBytes: config.response_bytes,
			onFailure: (error) => controller.abort(error),
			onBytes(bytes) {
				downloadedBytes += bytes;
				if (!closing) context.onUpdate?.({ content: `Downloading ${downloadedBytes} bytes...`, details: { status: "progress", phase: "downloading", received_bytes: downloadedBytes } });
			},
		}),
	});
	// SDK 的可空 sessionId getter 不满足 exactOptionalPropertyTypes，转发本次连接所需接口。
	const connection: Transport = {
		start: () => transport.start(), send: (message, sendOptions) => transport.send(message, sendOptions),
		close: () => transport.close(), setProtocolVersion: (version) => transport.setProtocolVersion(version),
	};
	transport.onmessage = (message) => connection.onmessage?.(message);
	transport.onerror = (error) => connection.onerror?.(error);
	transport.onclose = () => connection.onclose?.();
	const client = new Client({ name: "opi", version: "1.0.0" }, { capabilities: {} });
	// SDK 的 SSE 解析错误只通知 onerror，用同一个信号结束等待中的请求。
	client.onerror = (error) => { if (!closing) controller.abort(error); };
	context.onUpdate?.({ content: "Searching...", details: { status: "progress", phase: "requesting" } });
	try {
		await client.connect(connection, { signal });
		const result = await client.request({
			method: "tools/call",
			params: { name: "web_search_advanced_exa", arguments: {
				query: params.textQuery, numResults: params.limit, type: "auto",
				textMaxCharacters: config.highlight_chars,
				enableHighlights: true, highlightsMaxCharacters: config.highlight_chars,
				...(params.includeDomains.length === 0 ? {} : { includeDomains: params.includeDomains }),
				...(params.excludeDomains.length === 0 ? {} : { excludeDomains: params.excludeDomains }),
			} },
		}, CallToolResultSchema, { signal });
		context.onUpdate?.({ content: "Parsing results...", details: { status: "progress", phase: "parsing" } });
		const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
		if (result.isError) {
			const status = /error \((\d{3})\)/.exec(text)?.[1];
			const error = /rate limit/i.test(text) ? { code: "RATE_LIMITED" as const, message: "exa_mcp free rate limit exceeded." }
				: status === undefined ? { code: "HTTP_ERROR" as const, message: "exa_mcp search failed." }
				: classifyHttpStatus(Number(status), text);
			return failed(params.query, error.code, error.message);
		}
		const raw: unknown = JSON.parse(text);
		if (typeof raw !== "object" || raw === null || !("results" in raw) || !Array.isArray(raw.results)) {
			return failed(params.query, "PARSE_FAILED", "exa_mcp returned an invalid search response.");
		}
		return normalizeProviderResponse("exa_mcp", raw, params, downloadedBytes);
	} catch (error) {
		if (context.userSignal?.aborted || context.deadlineAt === undefined && context.signal?.aborted) return failed(params.query, "ABORTED", "websearch request was aborted.");
		if (timeout.aborted || context.deadlineAt !== undefined && context.now() >= context.deadlineAt) return failed(params.query, "TIMEOUT", "websearch deadline exceeded.");
		return failureFromError(params.query, controller.signal.aborted ? controller.signal.reason : error);
	} finally {
		closing = true;
		try {
			await transport.terminateSession();
		} catch {
			// 远端清理失败不覆盖搜索结果，本地连接始终关闭。
		} finally {
			await client.close();
			controller.abort();
		}
	}
}

function failureFromError(query: string, error: unknown): SearchProviderResult {
	if (error instanceof ExaMcpHttpError) return failed(query, error.code, error.message);
	if (error instanceof StreamableHTTPError) {
		if (error.code === -1) return failed(query, "UNSUPPORTED_CONTENT_TYPE", "exa_mcp returned an unsupported content type.");
		if (error.code !== undefined) {
			const classified = classifyHttpStatus(error.code, error.message);
			return failed(query, classified.code, classified.message, error.code);
		}
	}
	if (error instanceof SyntaxError || error instanceof Error && error.name === "ZodError") return failed(query, "PARSE_FAILED", "exa_mcp returned an invalid MCP response.");
	if (error instanceof McpError) {
		const code = error.code === ErrorCode.RequestTimeout ? "TIMEOUT"
			: error.code === ErrorCode.InvalidParams ? "INVALID_ARGUMENT"
			: error.code === ErrorCode.MethodNotFound || error.code === ErrorCode.InvalidRequest ? "CONFIG_ERROR"
			: error.code === ErrorCode.ParseError ? "PARSE_FAILED" : "HTTP_ERROR";
		return failed(query, code, "exa_mcp protocol request failed.");
	}
	const code = classifyNetworkError(error);
	return failed(query, code === "BLOCKED_ADDRESS" ? "CONNECTION_FAILED" : code, (error instanceof Error ? error.message : String(error)).slice(0, 300));
}

function failed(query: string, code: WebSearchErrorCode, message: string, httpStatus?: number): SearchProviderResult {
	return { status: "failed", provider: "exa_mcp", details: {
		status: "failed", provider: "exa_mcp", query, error: { code, message },
		...(httpStatus === undefined ? {} : { http_status: httpStatus }),
	} };
}

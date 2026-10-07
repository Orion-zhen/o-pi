import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Dispatcher } from "undici";

import type { WebSearchErrorCode } from "../core/types.ts";
import type { WebHttpFetch, WebHttpBody } from "../network/types.ts";
import { cancelBody, responseContentLength } from "../network/response-body.ts";

export class ExaMcpHttpError extends Error {
	constructor(readonly code: WebSearchErrorCode, message: string) {
		super(message);
	}
}

/** SDK 负责协议，适配层只绑定共享网络策略和响应资源限制。 */
export function createExaMcpFetch(options: {
	fetchImpl: WebHttpFetch;
	dispatcher: () => Promise<Dispatcher>;
	signal: AbortSignal;
	maxBytes: number;
	onBytes: (bytes: number) => void;
	onFailure: (error: unknown) => void;
}): FetchLike {
	return async (input, init) => {
		const method = init?.method ?? "GET";
		if (method !== "GET" && method !== "POST" && method !== "DELETE") throw new Error(`unsupported MCP HTTP method: ${method}`);
		if (init?.body !== undefined && typeof init.body !== "string") throw new Error("MCP request body must be a string.");
		// 会话终止独立于已取消的搜索，最多等待一秒。
		const budget = method === "DELETE" ? AbortSignal.timeout(1000) : options.signal;
		const signal = init?.signal == null ? budget : AbortSignal.any([budget, init.signal]);
		signal.throwIfAborted();
		const response = await options.fetchImpl(new URL(input), {
			method, redirect: "manual", dispatcher: await options.dispatcher(), signal,
			headers: Object.fromEntries(new Headers(init?.headers)),
			...(init?.body === undefined ? {} : { body: init.body }),
		});
		const headers = new Headers();
		for (const name of ["content-type", "mcp-session-id"]) {
			const value = response.headers.get(name);
			if (value !== null) headers.set(name, value);
		}
		const expected = responseContentLength(response.headers);
		if (expected !== undefined && expected > options.maxBytes) {
			cancelBody(response.body);
			throw tooLarge(options.maxBytes);
		}
		// 这些状态的 Response 不允许携带正文。
		const body = response.body === null || response.status === 204 || response.status === 205 || response.status === 304
			? (cancelBody(response.body), null)
			: limitedStream(response.body, signal, options.maxBytes, options.onBytes, options.onFailure);
		return new Response(body, { status: response.status, statusText: response.statusText, headers });
	};
}

function limitedStream(body: WebHttpBody, signal: AbortSignal, maxBytes: number, onBytes: (bytes: number) => void, onFailure: (error: unknown) => void): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	let received = 0;
	let finished = false;
	let onAbort: () => void;
	const finish = () => {
		finished = true;
		signal.removeEventListener("abort", onAbort);
	};
	return new ReadableStream<Uint8Array>({
		start(controller) {
			onAbort = () => {
				if (finished) return;
				finish();
				cancelBody(reader);
				controller.error(signal.reason);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (finished) return;
				if (done) {
					finish();
					controller.close();
					return;
				}
				if (value === undefined) return;
				received += value.byteLength;
				onBytes(value.byteLength);
				if (received > maxBytes) throw tooLarge(maxBytes);
				controller.enqueue(value);
			} catch (error) {
				if (finished) return;
				finish();
				cancelBody(reader);
				onFailure(error);
				controller.error(error);
			}
		},
		cancel() {
			finish();
			return reader.cancel();
		},
	});
}

function tooLarge(maxBytes: number): ExaMcpHttpError {
	return new ExaMcpHttpError("RESPONSE_TOO_LARGE", `exa_mcp response exceeded ${maxBytes} bytes.`);
}

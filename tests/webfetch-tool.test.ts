import { describe, expect, it } from "vitest";
import { Agent } from "undici";

import { defaultWebToolsConfig } from "../src/web-tools/config.js";
import { SnapshotCache } from "../src/web-tools/snapshot-cache.js";
import type { CookieStore, WebHttpFetch, WebHttpResponse } from "../src/web-tools/types.js";
import { executeWebFetch } from "../src/web-tools/webfetch-tool.js";

class FakeBody {
	constructor(private readonly chunks: Uint8Array[]) {}
	getReader() {
		let index = 0;
		return {
			read: async () => {
				const value = this.chunks[index];
				index += 1;
				return value === undefined ? { done: true as const } : { done: false as const, value };
			},
			cancel: async () => undefined,
		};
	}
	async cancel(): Promise<void> {}
}

const cookieStore: CookieStore = {
	async getCookieAccess() {
		return { authenticated: false, fingerprint: "none" };
	},
	async storeFromResponse() {
		return undefined;
	},
};

function response(status: number, body: string, headers: Record<string, string> = { "content-type": "text/plain" }): WebHttpResponse {
	return {
		status,
		statusText: status === 200 ? "OK" : "Error",
		headers: new Headers(headers),
		body: new FakeBody([Buffer.from(body)]),
	};
}

function runtime(fetchImpl: WebHttpFetch, maxChars = 100000) {
	const config = defaultWebToolsConfig();
	config.webfetch.limits.default_output_chars = 1000;
	config.webfetch.limits.max_output_chars = maxChars;
	return {
		dispatcher: new Agent(),
		fetchImpl,
		cookieStore,
		snapshots: new SnapshotCache(),
		approvedAuthOrigins: new Set<string>(),
		config,
		context: { toolCallId: "t1", hasUI: false },
		now: () => Date.now(),
	};
}

describe("webfetch tool", () => {
	it("返回包装后的成功文本和 next_offset，并用 snapshot 继续读取", async () => {
		let calls = 0;
		const long = `${"a".repeat(900)}\n${"b".repeat(900)}`;
		const fetchImpl: WebHttpFetch = async () => {
			calls += 1;
			return response(200, long);
		};
		const rt = runtime(fetchImpl);
		const first = await executeWebFetch({ url: "https://example.com/page", limit: 1000 }, rt);
		expect(first.details.status).toBe("success");
		expect(first.content).toContain("<webfetch_result");
		if (first.details.status !== "success") throw new Error("failed");
		expect(first.details.range.next_offset).toBeDefined();
		const nextOffset = first.details.range.next_offset;
		if (nextOffset === undefined) throw new Error("missing next_offset");

		const second = await executeWebFetch({ url: "https://example.com/page", offset: nextOffset, limit: 1000 }, rt);
		expect(second.details).toMatchObject({ status: "success", snapshot: "hit" });
		expect(calls).toBe(1);
	});

	it("redirect 到私网会被重新校验并拒绝", async () => {
		const fetchImpl: WebHttpFetch = async () => ({
			status: 302,
			statusText: "Found",
			headers: new Headers({ location: "http://127.0.0.1/private" }),
			body: new FakeBody([]),
		});
		const result = await executeWebFetch({ url: "https://example.com/start" }, runtime(fetchImpl));
		expect(result.details).toMatchObject({ status: "failed", error: { code: "BLOCKED_ADDRESS" } });
	});

	it("正文超限和 HTTP 错误返回结构化 failure", async () => {
		const tooLarge = await executeWebFetch({ url: "https://example.com/big" }, runtime(async () => response(200, "x", { "content-type": "text/plain", "content-length": "10485761" })));
		expect(tooLarge.details).toMatchObject({ status: "failed", error: { code: "RESPONSE_TOO_LARGE" } });

		const forbidden = await executeWebFetch({ url: "https://example.com/private" }, runtime(async () => response(403, "denied", { "content-type": "text/plain" })));
		expect(forbidden.details).toMatchObject({ status: "failed", error: { code: "HTTP_ERROR" }, response_preview: "denied" });
	});

	it("参数 limit 超过配置上限会拒绝", async () => {
		const result = await executeWebFetch({ url: "https://example.com/", limit: 2000 }, runtime(async () => response(200, "ok"), 1000));
		expect(result.details).toMatchObject({ status: "failed", error: { code: "INVALID_ARGUMENT" } });
	});
});

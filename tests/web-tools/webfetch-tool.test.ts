import { describe, expect, it } from "vitest";
import { Agent } from "undici";

import { defaultWebToolsConfig } from "../../src/web-tools/config.js";
import { SnapshotCache } from "../../src/web-tools/snapshot-cache.js";
import type { CookieStore, WebHttpFetch } from "../../src/web-tools/types.js";
import { executeWebFetch } from "../../src/web-tools/webfetch-tool.js";
import { httpResponse } from "../helpers/http.js";

const cookieStore: CookieStore = {
	async getCookieAccess() {
		return { authenticated: false, fingerprint: "none" };
	},
	async storeFromResponse() {
		return undefined;
	},
};

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
			return httpResponse(200, long);
		};
		const rt = runtime(fetchImpl);
		const first = await executeWebFetch({ url: "https://example.com/page", limit: 1000 }, rt);
		expect(first.details.status).toBe("success");
		expect(first.content).toContain("<webfetch_result");
		if (first.details.status !== "success") throw new Error("failed");
		expect(first.details.range.next_offset).toBeDefined();
		expect(first.details.range.has_more).toBe(true);
		expect(first.details.next).toContain("offset");
		expect(first.content).toContain('has_more="true"');
		expect(first.content).toContain("<next>");
		const nextOffset = first.details.range.next_offset;
		if (nextOffset === undefined) throw new Error("missing next_offset");

		const second = await executeWebFetch({ url: "https://example.com/page", offset: nextOffset, limit: 1000 }, rt);
		expect(second.details).toMatchObject({ status: "success", snapshot: "hit" });
		if (second.details.status !== "success") throw new Error("failed");
		expect(second.details.range.has_more).toBe(false);
		expect(calls).toBe(1);
	});

	it("redirect 到私网会被重新校验并拒绝", async () => {
		const fetchImpl: WebHttpFetch = async () => ({
			status: 302,
			statusText: "Found",
			headers: new Headers({ location: "http://127.0.0.1/private" }),
			body: httpResponse(200, "").body,
		});
		const result = await executeWebFetch({ url: "https://example.com/start" }, runtime(fetchImpl));
		expect(result.details).toMatchObject({ status: "failed", error: { code: "BLOCKED_ADDRESS" } });
		expect(result.content).toContain('<error tool="webfetch" code="BLOCKED_ADDRESS">');
		expect(result.content).not.toContain("\n  ");
	});

	it("正文超限和 HTTP 错误返回结构化 failure", async () => {
		const tooLarge = await executeWebFetch({ url: "https://example.com/big" }, runtime(async () => httpResponse(200, "x", { "content-type": "text/plain", "content-length": "10485761" })));
		expect(tooLarge.details).toMatchObject({ status: "failed", error: { code: "RESPONSE_TOO_LARGE" } });
		expect(tooLarge.content).toContain('<error tool="webfetch" code="RESPONSE_TOO_LARGE">');

		const forbidden = await executeWebFetch({ url: "https://example.com/private" }, runtime(async () => httpResponse(403, "denied", { "content-type": "text/plain" })));
		expect(forbidden.details).toMatchObject({ status: "failed", error: { code: "HTTP_ERROR" }, response_preview: "denied" });
		expect(forbidden.content).toContain('<error tool="webfetch" code="HTTP_ERROR">');
	});

	it("参数 limit 超过配置上限会拒绝", async () => {
		const result = await executeWebFetch({ url: "https://example.com/", limit: 2000 }, runtime(async () => httpResponse(200, "ok"), 1000));
		expect(result.details).toMatchObject({ status: "failed", error: { code: "INVALID_ARGUMENT" } });
		expect(result.content).toContain('<error tool="webfetch" code="INVALID_ARGUMENT">');
	});
});

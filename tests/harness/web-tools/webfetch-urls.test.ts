import { Agent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeWebFetch } from "../../../src/harness/web-tools/fetch/webfetch-tool.js";
import { SnapshotCache } from "../../../src/harness/web-tools/fetch/snapshot-cache.js";
import type { WebHttpFetch } from "../../../src/harness/web-tools/network/types.js";
import { defaultWebToolsConfig } from "./config-fixture.js";
import { httpResponse } from "../../helpers/http.js";

const dispatchers: Agent[] = [];
afterEach(async () => { await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close())); });

function runtime(fetchImpl: WebHttpFetch) {
	const dispatcher = new Agent();
	dispatchers.push(dispatcher);
	const config = defaultWebToolsConfig();
	config.webfetch.media.mode = "auto";
	return {
		dispatcher, fetchImpl, config,
		cookieStore: { async getCookieAccess() { return {}; }, async storeFromResponse() { return undefined; } },
		snapshots: new SnapshotCache(), approvedAuthOrigins: new Set<string>(),
		context: { toolCallId: "url", acceptsImages: true }, now: () => Date.now(),
	};
}

describe("webfetch URL 边界", () => {
	it.each(["not a URL", "https://[broken", "file:///etc/passwd", "https://user:secret@example.com/docs"])(
		"无效 URL 返回结构化错误，分页和查找也不发请求：%s", async (url) => {
			const fetchImpl = vi.fn(async () => httpResponse(200, "unexpected"));
			const rt = runtime(fetchImpl);
			for (const selection of [{}, { offset: 0 }, { find: "target" }]) {
				const result = await executeWebFetch({ url, ...selection }, rt);
				expect(result.details).toMatchObject({ status: "failed", error: { code: "INVALID_URL" }, duration_ms: expect.any(Number) });
				expect(result.content).toContain('code="INVALID_URL"');
				expect(result.content).not.toContain("secret");
			}
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);

	it("等价 URL 使用同一个快照，规范化不影响 HTTP 目标", async () => {
		const requests: string[] = [];
		const rt = runtime(async (url) => { requests.push(url.toString()); return httpResponse(200, "target body"); });
		await executeWebFetch({ url: "https://EXAMPLE.com:443/docs" }, rt);
		const result = await executeWebFetch({ url: "https://example.com/docs", offset: 0 }, rt);
		expect(result.details).toMatchObject({ status: "success", snapshot: "hit" });
		expect(result.content).toContain("target body");
		expect(requests).toEqual(["https://example.com/docs"]);
	});

	it("source 模式的不同 fragment 复用整页快照", async () => {
		const requests: string[] = [];
		const rt = runtime(async (url) => { requests.push(url.toString()); return httpResponse(200, "target body"); });
		await executeWebFetch({ url: "https://example.com/docs#first", mode: "source" }, rt);
		const result = await executeWebFetch({ url: "https://example.com/docs#second", mode: "source", find: "target" }, rt);
		expect(result.details).toMatchObject({ status: "success", snapshot: "hit", range: { kind: "find", matches: 1 } });
		expect(result.details).not.toHaveProperty("anchor");
		expect(requests).toEqual(["https://example.com/docs"]);
	});

	it("主图的首次请求独立拒绝私网目标，不丢弃已取得的页面正文", async () => {
		const requests: string[] = [];
		const rt = runtime(async (url) => {
			requests.push(url.toString());
			return httpResponse(200, '<main><h1>Image post</h1><img src="http://127.0.0.1/private.png" alt="A detailed primary post image"></main>', { "content-type": "text/html" });
		});
		const result = await executeWebFetch({ url: "https://example.com/post" }, rt);
		expect(result.details).toMatchObject({
			status: "success", completeness: "partial",
			omissions: [{ kind: "primary_media", reason: "media_fetch_failed" }],
		});
		expect(result.media).toBeUndefined();
		expect(requests).toEqual(["https://example.com/post"]);
	});
});

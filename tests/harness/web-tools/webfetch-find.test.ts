import { Agent } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import { executeWebFetch, type ExecuteWebFetchRuntime } from "../../../src/harness/web-tools/fetch/webfetch-tool.js";
import { SnapshotCache } from "../../../src/harness/web-tools/fetch/snapshot-cache.js";
import type { WebFetchResult, WebFetchSuccessDetails } from "../../../src/harness/web-tools/core/types.js";
import type { WebHttpFetch } from "../../../src/harness/web-tools/network/types.js";
import { defaultWebToolsConfig } from "./config-fixture.js";
import { httpResponse } from "../../helpers/http.js";

const dispatchers: Agent[] = [];
afterEach(async () => { await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close())); });

function runtime(fetchImpl: WebHttpFetch): ExecuteWebFetchRuntime {
	const dispatcher = new Agent();
	dispatchers.push(dispatcher);
	const config = defaultWebToolsConfig();
	config.webfetch.media.mode = "auto";
	return {
		dispatcher, fetchImpl, config,
		cookieStore: { async getCookieAccess() { return {}; }, async storeFromResponse() { return undefined; } },
		snapshots: new SnapshotCache(), approvedAuthOrigins: new Set<string>(),
		context: { toolCallId: "find", acceptsImages: true }, now: () => Date.now(),
	};
}

function found(result: WebFetchResult) {
	if (result.details.status !== "success") throw new Error(result.details.error.message);
	if (result.details.range.kind !== "find") throw new Error("not a find result");
	return { details: result.details, range: result.details.range };
}

function assertPassages(result: WebFetchResult, original: string, limit: number): WebFetchSuccessDetails {
	const { details, range } = found(result);
	let chars = 0;
	let end = range.start;
	for (const passage of range.passages) {
		expect(passage.start).toBeGreaterThanOrEqual(end);
		expect(passage.end).toBeGreaterThan(passage.start);
		expect(result.content).toContain(`[${passage.start}-${passage.end}]\n${original.slice(passage.start, passage.end)}`);
		chars += passage.end - passage.start;
		end = passage.end;
	}
	expect(chars).toBeLessThanOrEqual(limit);
	expect(result.content).not.toMatch(/[\uD800-\uDFFF]/u);
	return details;
}

const URL = "https://example.com/docs";
const GAP = "Unrelated documentation paragraph. ".repeat(40);
const SECTIONS = Array.from({ length: 5 }, (_, index) => `Occurrence ${index}: AbortSignal controls cancellation.`);
const LONG = SECTIONS.join(`\n\n${GAP}\n\n`);

describe("webfetch find", () => {
	it("直接定位少量多处命中，并用同一 snapshot 继续查找，不返回整页", async () => {
		let calls = 0;
		const rt = runtime(async () => { calls += 1; return httpResponse(200, LONG); });
		rt.config.webfetch.limits.find_max_passages = 3;
		const first = await executeWebFetch({ url: URL, find: "abortsignal" }, rt);
		const { range } = found(first);
		expect(range).toMatchObject({ start: 0, matches: 3, has_more: true });
		expect(range.passages).toHaveLength(3);
		expect(range.next_offset).toBe(LONG.indexOf("AbortSignal", LONG.indexOf("Occurrence 3")));
		assertPassages(first, LONG, 2400);
		expect(first.content).toContain('matches="3"');
		expect(first.content).not.toContain(GAP);
		expect(first.content).not.toContain("partial=");
		if (range.next_offset === undefined) throw new Error("missing next offset");
		const second = await executeWebFetch({ url: URL, find: "abortsignal", offset: range.next_offset }, rt);
		expect(found(second).range).toMatchObject({ matches: 2, has_more: false });
		expect(second.details).toMatchObject({ snapshot: "hit", completeness: "complete" });
		expect(second.content).not.toContain("Occurrence 0");
		expect(calls).toBe(1);
	});

	it("片段数服从本次配置，修改数量后仍复用相同文本 snapshot", async () => {
		let calls = 0;
		const rt = runtime(async () => { calls += 1; return httpResponse(200, LONG); });
		for (const maxPassages of [1, 4]) {
			rt.config.webfetch.limits.find_max_passages = maxPassages;
			const result = await executeWebFetch({ url: URL, find: "AbortSignal" }, rt);
			expect(found(result).range.passages).toHaveLength(maxPassages);
			expect(found(result).range.matches).toBe(maxPassages);
		}
		expect(calls).toBe(1);
	});

	it("按字面子串忽略大小写，合并邻近命中，保留原文及 Unicode 坐标", async () => {
		const body = `İ 😀 中文前缀\n\nCall FOO() here, then foo() again. foooooo does not match.\n\n${GAP}`;
		const result = await executeWebFetch({ url: URL, find: "foo()", limit: 300 }, runtime(async () => httpResponse(200, body)));
		expect(found(result).range).toMatchObject({ matches: 2, has_more: false });
		expect(found(result).range.passages).toHaveLength(1);
		assertPassages(result, body, 300);
		expect(result.content).toContain("FOO()");
		expect(result.content).toContain("foo()");
	});

	it("尽量保留短代码块，代码中的空行不切断上下文", async () => {
		const block = '```ts\nconst controller = new AbortController();\n\nawait request({ signal: controller.signal });\n```';
		const body = `${GAP}\n\n${block}\n\n${GAP}`;
		const result = await executeWebFetch({ url: URL, find: "controller.signal", limit: 400 }, runtime(async () => httpResponse(200, body, { "content-type": "text/markdown" })));
		expect(result.content).toContain(block);
		assertPassages(result, body, 400);
	});

	it("limit 是所有片段的原文预算，缩减上下文而不切断命中或字符", async () => {
		const body = "😀😀 token 😀😀\n\nsecond TOKEN tail";
		const rt = runtime(async () => httpResponse(200, body));
		const first = await executeWebFetch({ url: URL, find: "token", limit: 5 }, rt);
		expect(found(first).range).toMatchObject({ matches: 1, has_more: true });
		assertPassages(first, body, 5);
		const nextOffset = found(first).range.next_offset;
		if (nextOffset === undefined) throw new Error("missing next offset");
		const next = await executeWebFetch({ url: URL, find: "token", limit: 5, offset: nextOffset }, rt);
		expect(found(next).range).toMatchObject({ matches: 1, has_more: false });
		assertPassages(next, body, 5);
	});

	it("包含辅助平面字符的长查找串不会被上下文软上限切断", async () => {
		const find = "𝒜".repeat(450);
		const body = `Formula: ${find}.`;
		const result = await executeWebFetch({ url: URL, find, limit: find.length }, runtime(async () => httpResponse(200, body)));
		expect(found(result).range.matches).toBe(1);
		expect(result.content).toContain(find);
		assertPassages(result, body, find.length);
	});

	it("预算不足以容纳一个完整命中时，在请求前明确拒绝", async () => {
		let calls = 0;
		const result = await executeWebFetch({ url: URL, find: "AbortSignal", limit: 2 }, runtime(async () => { calls += 1; return httpResponse(200, LONG); }));
		expect(result.details).toMatchObject({ status: "failed", error: { code: "INVALID_ARGUMENT" } });
		expect(calls).toBe(0);
	});

	it("没有命中是成功的空结果，offset 之后没有匹配时不回到开头", async () => {
		let calls = 0;
		const rt = runtime(async () => { calls += 1; return httpResponse(200, "only Token here"); });
		const empty = await executeWebFetch({ url: URL, find: "absent" }, rt);
		expect(found(empty).range).toMatchObject({ matches: 0, passages: [], has_more: false });
		expect(empty.content).toContain('matches="0"');
		expect(empty.content).not.toContain("only Token");
		const beyond = await executeWebFetch({ url: URL, find: "token", offset: 100 }, rt);
		expect(found(beyond).range).toMatchObject({ matches: 0, start: 15, has_more: false });
		expect(beyond.content).not.toContain('next="');
		expect(calls).toBe(1);
	});

	it.each([
		["text/plain", "A literal Target value.", "target"],
		["text/markdown", "## Reference\n\nA literal Target value.", "target"],
		["text/csv", "name,value\nTarget,12", "target"],
		["application/javascript", "const Target = () => 1;", "target"],
		["application/json", '{"value":"Target","escaped":"\\u4e2d"}', "target"],
		["application/xml", '<root><item name="Target"/></root>', "target"],
		["application/rss+xml", "<rss><title>Target</title></rss>", "target"],
		["application/atom+xml", "<feed><title>Target</title></feed>", "target"],
	])("在 %s 的现有文本表示中查找", async (contentType, body, find) => {
		const result = await executeWebFetch({ url: URL, find }, runtime(async () => httpResponse(200, body, { "content-type": contentType })));
		expect(found(result).range.matches).toBe(1);
		assertPassages(result, body, 2400);
	});

	it("JSON 不额外解码字符串，也不解释字段路径", async () => {
		const rt = runtime(async () => httpResponse(200, '{"escaped":"\\u4e2d","nested":{"name":"hello"}}', { "content-type": "application/json" }));
		for (const find of ["中", "$.nested.name"]) {
			const result = await executeWebFetch({ url: URL, find }, rt);
			expect(found(result).range.matches).toBe(0);
		}
		expect(found(await executeWebFetch({ url: URL, find: "\\u4e2d" }, rt)).range.matches).toBe(1);
	});

	it("readable 不搜索已移除的源码，source 显式查找属性和脚本", async () => {
		const html = '<html><body><main><h1>Guide</h1><p>This public paragraph explains the supported settings.</p></main><script>privateCall()</script></body></html>';
		let calls = 0;
		const rt = runtime(async () => { calls += 1; return httpResponse(200, html, { "content-type": "text/html" }); });
		const readable = await executeWebFetch({ url: URL, find: "privateCall()" }, rt);
		expect(found(readable).range.matches).toBe(0);
		expect(calls).toBe(1);
		const source = await executeWebFetch({ url: URL, mode: "source", find: "privateCall()" }, rt);
		expect(found(source).range.matches).toBe(1);
		assertPassages(source, html, 2400);
		expect(calls).toBe(2);
	});

	it("锚点先限定查找范围，source 则忽略锚点", async () => {
		const html = '<html><body><main><h2 id="auth">Authentication</h2><p>Use a Token here.</p><h2 id="errors">Errors</h2><p>OutsideToken is only here.</p></main></body></html>';
		const rt = runtime(async () => httpResponse(200, html, { "content-type": "text/html" }));
		const inside = await executeWebFetch({ url: `${URL}#auth`, find: "token" }, rt);
		expect(found(inside).range.matches).toBe(1);
		expect(inside.details).toMatchObject({ anchor: "auth" });
		expect(inside.content).not.toContain("OutsideToken");
		const absent = await executeWebFetch({ url: `${URL}#auth`, find: "OutsideToken" }, rt);
		expect(found(absent).range.matches).toBe(0);
		const source = await executeWebFetch({ url: `${URL}#auth`, mode: "source", find: "OutsideToken" }, rt);
		expect(found(source).range.matches).toBe(1);
	});

	it("复用已读整页，换查找词和显式 offset 扩读均不重新下载", async () => {
		let calls = 0;
		const body = "Token reference. Find the second name below.\n\nAnotherName appears here.";
		const rt = runtime(async () => { calls += 1; return httpResponse(200, body); });
		await executeWebFetch({ url: URL }, rt);
		const result = await executeWebFetch({ url: URL, find: "token" }, rt);
		const range = found(result).range.passages[0];
		if (range === undefined) throw new Error("missing passage");
		await executeWebFetch({ url: URL, find: "AnotherName" }, rt);
		const expanded = await executeWebFetch({ url: URL, offset: range.start, limit: 100 }, rt);
		expect(expanded.details).toMatchObject({ snapshot: "hit", range: { kind: "read" } });
		expect(expanded.content).toContain(body);
		expect(calls).toBe(1);
		await executeWebFetch({ url: URL }, rt);
		expect(calls).toBe(2);
	});

	it("文本查找不下载主图或报告主动省略的媒体，真实 iframe 遗漏仍保留", async () => {
		const html = '<html><head><meta property="og:type" content="video.other"><meta property="og:image" content="/poster.png"></head><body><main><h1>Lesson</h1><p>The static transcript mentions Token usage.</p><iframe src="/player"></iframe></main></body></html>';
		const requests: string[] = [];
		const result = await executeWebFetch({ url: URL, find: "token" }, runtime(async (url) => { requests.push(url.toString()); return httpResponse(200, html, { "content-type": "text/html" }); }));
		expect(result.media).toBeUndefined();
		expect(requests).toEqual([URL]);
		expect(result.details).toMatchObject({ completeness: "partial", omissions: [{ kind: "embedded_content", reason: "iframe_not_fetched" }], media: { returned: 0 } });
		expect(result.content).not.toContain("video_not_returned");
	});

	it("直接图片不搜索占位文字，并在响应头阶段取消图片 body", async () => {
		let reads = 0;
		let cancelled = 0;
		const result = await executeWebFetch({ url: URL, find: "Image response" }, runtime(async () => ({
			status: 200, statusText: "OK", headers: new Headers({ "content-type": "image/png" }),
			body: {
				getReader() { return { async read() { reads += 1; return { done: true }; }, async cancel() { cancelled += 1; } }; },
				async cancel() { cancelled += 1; },
			},
		})));
		expect(result.details).toMatchObject({ status: "failed", error: { code: "UNSUPPORTED_CONTENT_TYPE" } });
		expect(reads).toBe(0);
		expect(cancelled).toBe(1);
	});

	it.each(["application/pdf", "audio/mpeg", "video/mp4"])("不为 find 增加 %s 解析", async (contentType) => {
		const result = await executeWebFetch({ url: URL, find: "target" }, runtime(async () => httpResponse(200, "target", { "content-type": contentType })));
		expect(result.details).toMatchObject({ status: "failed", error: { code: "UNSUPPORTED_CONTENT_TYPE" } });
	});

	it("查找缓存时也尊重已取消的调用", async () => {
		const rt = runtime(async () => httpResponse(200, "Token body"));
		await executeWebFetch({ url: URL, find: "token" }, rt);
		rt.context.signal = AbortSignal.abort();
		const result = await executeWebFetch({ url: URL, find: "token" }, rt);
		expect(result.details).toMatchObject({ status: "failed", error: { code: "ABORTED" } });
		expect(result.content).not.toContain("Token body");
	});
});

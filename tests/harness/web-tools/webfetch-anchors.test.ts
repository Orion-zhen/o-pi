import { Agent } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import { executeWebFetch } from "../../../src/harness/web-tools/fetch/webfetch-tool.ts";
import { SnapshotCache } from "../../../src/harness/web-tools/fetch/snapshot-cache.ts";
import type { WebHttpFetch } from "../../../src/harness/web-tools/network/types.ts";
import { defaultWebToolsConfig } from "./config-fixture.ts";
import { httpResponse, redirectResponse } from "../../helpers/http.ts";

const dispatchers: Agent[] = [];
afterEach(async () => { await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close())); });

function runtime(fetchImpl: WebHttpFetch) {
	const dispatcher = new Agent();
	dispatchers.push(dispatcher);
	return {
		dispatcher, fetchImpl, config: defaultWebToolsConfig(),
		cookieStore: { async getCookieAccess() { return {}; }, async storeFromResponse() { return undefined; } },
		snapshots: new SnapshotCache(), approvedAuthOrigins: new Set<string>(),
		context: { toolCallId: "anchor", acceptsImages: false }, now: () => Date.now(),
	};
}

const HTML = `<html><head><title>Entire guide</title>
	<meta property="og:image" content="https://example.com/unrelated.png">
	<script type="application/ld+json">{"@type":"Article","articleBody":"Unrelated structured article body."}</script>
	</head><body><main><h1>Entire guide</h1><p>Introduction outside the selection.</p>
	<div><h2 id="authentication">Authentication</h2><p>${"Use a scoped access token. ".repeat(100)}</p></div>
	<div><h3 id="refresh">Refresh</h3><p>Renew the access token before expiry.</p>
	<pre><code>const token = await refresh();</code></pre></div>
	<div><h2 id="errors">Errors</h2><p>Unrelated error reference.</p><iframe src="/player"></iframe></div>
	</main></body></html>`;

function htmlResponse(html = HTML) { return httpResponse(200, html, { "content-type": "text/html" }); }

describe("webfetch 原生锚点", () => {
	it("跨容器读取标题及其子章节，选区外元数据和遗漏不混入结果", async () => {
		const requests: string[] = [];
		const result = await executeWebFetch({ url: "https://example.com/docs#authentication" }, runtime(async (url, init) => {
			requests.push(url.toString());
			expect(init.headers.Accept).toMatch(/^text\/html/);
			return htmlResponse();
		}));
		expect(requests).toEqual(["https://example.com/docs"]);
		expect(result.details).toMatchObject({ status: "success", anchor: "authentication", completeness: "complete", omissions: [], title: "Authentication" });
		for (const text of ["Authentication", "Use a scoped access token", "Refresh", "const token = await refresh();"]) expect(result.content).toContain(text);
		for (const text of ["Entire guide", "Introduction outside", "Unrelated", "unrelated.png", "partial="]) expect(result.content).not.toContain(text);
		expect(result.content).toContain('anchor="authentication"');
	});

	it("正文包含章节标题词时，不把整段正文当成标题重复内容删除", async () => {
		const html = '<html><body><main><h2 id="auth">Authentication</h2><p>Authentication requires a scoped token and an explicit expiry.</p><h2>Next</h2></main></body></html>';
		const result = await executeWebFetch({ url: "https://example.com/docs#auth" }, runtime(async () => htmlResponse(html)));
		expect(result.content).toContain("Authentication requires a scoped token and an explicit expiry.");
		expect(result.content).not.toContain("Next");
	});

	it("不同锚点和整页使用独立 snapshot，分页偏移相对所选章节", async () => {
		let calls = 0;
		const rt = runtime(async () => { calls += 1; return htmlResponse(); });
		rt.config.webfetch.limits.default_output_chars = 1000;
		const whole = await executeWebFetch({ url: "https://example.com/docs" }, rt);
		const first = await executeWebFetch({ url: "https://example.com/docs#authentication" }, rt);
		const other = await executeWebFetch({ url: "https://example.com/docs#errors" }, rt);
		if (first.details.status !== "success" || first.details.range.next_offset === undefined) throw new Error("missing range");
		rt.config.webfetch.limits.default_output_chars = 20000;
		const next = await executeWebFetch({ url: "https://example.com/docs#authentication", offset: first.details.range.next_offset }, rt);
		expect(whole.content).toContain("Entire guide");
		expect(other.content).not.toContain("Authentication");
		expect(next.details).toMatchObject({ status: "success", snapshot: "hit", anchor: "authentication", completeness: "complete" });
		expect(next.content).toContain("Renew the access token");
		expect(next.content).not.toContain("Unrelated error reference");
		expect(next.content).not.toContain("partial=");
		expect(calls).toBe(3);
	});

	it.each([
		['<h2 id="配置">Settings</h2><p>Selected body.</p><h2>Next</h2><p>Outside body.</p>', "%E9%85%8D%E7%BD%AE"],
		['<h2><a id="named"></a>Settings</h2><p>Selected body.</p><h2>Next</h2><p>Outside body.</p>', "named"],
		['<a name="named"></a><h2>Settings</h2><p>Selected body.</p><h2>Next</h2><p>Outside body.</p>', "named"],
		['<section id="section"><h2>Settings</h2><p>Selected body.</p></section><p>Outside body.</p>', "section"],
		['<p id="note">Selected body.</p><p>Outside body.</p>', "note"],
	])("按真实目标读取 Unicode、标题内锚点、命名锚点和容器：%s", async (body, hash) => {
		const result = await executeWebFetch({ url: `https://example.com/docs#${hash}` }, runtime(async () => htmlResponse(`<main>${body}</main>`)));
		expect(result.details.status).toBe("success");
		expect(result.content).toContain("Selected body.");
		expect(result.content).not.toContain("Outside body.");
	});

	it.each(["missing", "/route", "settings", "hidden", "in-template", "%E0%A4"])("不存在或非静态目标不回退到整页：%s", async (hash) => {
		const result = await executeWebFetch({ url: `https://example.com/docs#${hash}` }, runtime(async () => htmlResponse('<main><h2>Settings</h2><p>Do not return the whole page.</p><div hidden id="hidden">Hidden</div><template><h2 id="in-template">Later</h2></template></main>')));
		expect(result.details).toMatchObject({ status: "failed", error: { code: "ANCHOR_NOT_FOUND" } });
		expect(result.content).not.toContain("Do not return the whole page");
	});

	it.each([
		["/final", "authentication"],
		["/final#errors", "errors"],
		["/final#", undefined],
	])("重定向继承、替换或清空 fragment：%s", async (location, anchor) => {
		const requests: string[] = [];
		const result = await executeWebFetch({ url: "https://example.com/start#authentication" }, runtime(async (url) => {
			requests.push(url.toString());
			return requests.length === 1 ? redirectResponse(location) : htmlResponse();
		}));
		expect(requests).toEqual(["https://example.com/start", "https://example.com/final"]);
		expect(result.details.status).toBe("success");
		if (anchor === undefined) {
			expect(result.details).not.toHaveProperty("anchor");
			expect(result.content).toContain("Entire guide");
		} else expect(result.details).toHaveProperty("anchor", anchor);
	});

	it("正文链接保留 fragment，source 模式仍返回整份源码", async () => {
		const html = '<html><body><main><h1>Guide</h1><p>This guide describes how to configure credentials, renew access tokens, and diagnose request failures. Read the <a href="/docs#authentication">authentication section</a> and <a href="#errors">errors</a>.</p></main></body></html>';
		const rt = runtime(async () => htmlResponse(html));
		const readable = await executeWebFetch({ url: "https://example.com/docs" }, rt);
		expect(readable.content).toContain("https://example.com/docs#authentication");
		expect(readable.content).toContain("https://example.com/docs#errors");
		const source = await executeWebFetch({ url: "https://example.com/docs#missing", mode: "source" }, rt);
		expect(source.content).toContain(html);
		expect(source.details).not.toHaveProperty("anchor");
	});

	it("保留选区内的真实遗漏，不把选区外 iframe 带入结果", async () => {
		const rt = runtime(async () => htmlResponse(HTML.replace("Unrelated error reference.", "Unrelated error reference. ".repeat(100))));
		rt.config.webfetch.limits.default_output_chars = 1000;
		const result = await executeWebFetch({ url: "https://example.com/docs#errors" }, rt);
		expect(result.details).toMatchObject({ status: "success", completeness: "partial", omissions: [{ kind: "embedded_content", reason: "iframe_not_fetched" }] });
		expect(result.content).toContain('partial="iframe_not_fetched"');
		expect(result.content).toContain('next="');
	});

	it("声明位于选区外时，仍解析明确指向选区内目标的延迟正文", async () => {
		const html = '<html><body><main><h2 id="comments">Comments</h2><div id="reply">Loading</div><h2>Next</h2><p>Outside body.</p></main><template for="reply"><p>Resolved selected reply.</p></template></body></html>';
		const result = await executeWebFetch({ url: "https://example.com/docs#comments" }, runtime(async () => htmlResponse(html)));
		expect(result.content).toContain("Resolved selected reply.");
		expect(result.content).not.toContain("Outside body.");
		expect(result.details).toMatchObject({ status: "success", deferred_fragments: { discovered: 1, resolved: 1 }, completeness: "complete" });
	});

	it("非 HTML 响应不假装完成锚点选读", async () => {
		const result = await executeWebFetch({ url: "https://example.com/docs#authentication" }, runtime(async () => httpResponse(200, "# Authentication\nMarkdown without native IDs.", { "content-type": "text/markdown" })));
		expect(result.details).toMatchObject({ status: "failed", error: { code: "ANCHOR_NOT_FOUND" } });
	});
});

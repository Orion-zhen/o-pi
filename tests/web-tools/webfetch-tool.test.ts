import { describe, expect, it, vi } from "vitest";
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

function runtime(
	fetchImpl: WebHttpFetch,
	maxChars = 100000,
	acceptsImages = false,
	imageOmissionReason?: "api_no_tool_image_output",
) {
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
		context: {
			toolCallId: "t1",
			hasUI: false,
			acceptsImages,
			...(imageOmissionReason !== undefined ? { imageOmissionReason } : {}),
		},
		now: () => Date.now(),
	};
}

describe("webfetch tool", () => {
	it("为展开 Widget 保留最多 40 行、6000 字符的正文预览", async () => {
		const body = Array.from({ length: 50 }, (_, index) => `line-${index.toString().padStart(2, "0")} ${"x".repeat(200)}`).join("\n");
		const result = await executeWebFetch(
			{ url: "https://example.com/preview" },
			runtime(async () => httpResponse(200, body, { "content-type": "text/plain" })),
		);
		if (result.details.status !== "success") throw new Error("failed");
		expect(result.details.preview).toContain("line-20");
		expect(result.details.preview).not.toContain("line-40");
		expect(result.details.preview.length).toBe(6000);
	});

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
		expect(first.content).toContain("<webfetch ");
		if (first.details.status !== "success") throw new Error("failed");
		expect(first.details.range.next_offset).toBeDefined();
		expect(first.details.range.has_more).toBe(true);
		expect(first.details.next).toContain("offset");
		const nextOffset = first.details.range.next_offset;
		if (nextOffset === undefined) throw new Error("missing next_offset");
		expect(first.content).toContain(`kind="generic" partial="range" next="${nextOffset}"`);
		expect(first.content).not.toContain("https://example.com/page");
		expect(first.content).not.toContain("has_more");
		expect(first.content).not.toContain("<next>");

		const second = await executeWebFetch({ url: "https://example.com/page", offset: nextOffset, limit: 1000 }, rt);
		expect(second.details).toMatchObject({ status: "success", snapshot: "hit" });
		if (second.details.status !== "success") throw new Error("failed");
		expect(second.details.range.has_more).toBe(false);
		expect(second.details).toMatchObject({
			scope: "static_response",
			page_kind: "generic",
			text_source: "body",
			completeness: "partial",
			omissions: [{ kind: "text_range", reason: "range" }],
		});
		expect(second.content).toContain('<webfetch kind="generic" partial="range">');
		expect(second.content).not.toContain("scope=");
		expect(second.content).not.toContain("source=");
		expect(calls).toBe(1);
	});

	it("模型标签只在跳转后输出 final URL", async () => {
		let calls = 0;
		const result = await executeWebFetch(
			{ url: "https://example.com/start" },
			runtime(async () => {
				calls += 1;
				return calls === 1
					? {
							status: 302,
							statusText: "Found",
							headers: new Headers({ location: "/final" }),
							body: httpResponse(200, "").body,
						}
					: httpResponse(200, "redirected body", { "content-type": "text/plain" });
			}),
		);
		expect(result.details).toMatchObject({
			status: "success",
			requested_url: "https://example.com/start",
			final_url: "https://example.com/final",
			redirect_count: 1,
		});
		expect(result.content).toContain('<webfetch kind="generic" final="https://example.com/final">');
		expect(result.content).not.toContain("https://example.com/start");
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

	it("媒体主导 HTML 向支持图像的模型返回一张经过嗅探的主图", async () => {
		const html = '<main><h1>Image post</h1><img src="/post.png" alt="A detailed primary post image"></main>';
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
		const requests: Array<{ url: string; accept: string | undefined }> = [];
		const fetchImpl: WebHttpFetch = async (url, init) => {
			requests.push({ url: url.toString(), accept: init.headers["Accept"] });
			return url.pathname === "/post.png"
				? httpResponse(200, png, { "content-type": "application/octet-stream" })
				: httpResponse(200, html, { "content-type": "text/html" });
		};
		const result = await executeWebFetch({ url: "https://example.com/post" }, runtime(fetchImpl, 100000, true));
		expect(requests).toHaveLength(2);
		expect(requests[1]?.accept).toContain("image/png");
		expect(result.details).toMatchObject({
			status: "success",
			completeness: "complete",
			omissions: [],
			media: { discovered: 1, returned: 1 },
		});
		expect(result.media).toHaveLength(1);
		expect(result.media?.[0]).toMatchObject({ mimeType: "image/png", sourceUrl: "https://example.com/post.png" });
		expect(result.media?.[0]?.data).toEqual(Uint8Array.from(png));
		expect(result.content).toContain('<webfetch kind="image">');
		expect(result.content).not.toContain("partial=");
	});

	it("模型不支持图像时不下载主图，并明确报告遗漏", async () => {
		let calls = 0;
		const html = '<main><h1>Image post</h1><img src="/post.jpg" alt="A detailed primary post image"></main>';
		const result = await executeWebFetch(
			{ url: "https://example.com/post" },
			runtime(async () => {
				calls += 1;
				return httpResponse(200, html, { "content-type": "text/html" });
			}),
		);
		expect(calls).toBe(1);
		expect(result.details).toMatchObject({
			status: "success",
			completeness: "partial",
			omissions: [{ kind: "primary_media", reason: "model_no_image_input" }],
			media: { discovered: 1, returned: 0 },
		});
		expect(result.content).toContain('partial="model_no_image_input"');
		expect(result.content).not.toContain("<omitted");
	});

	it("API 不支持工具图片时不下载主图，并区分于模型图像能力", async () => {
		let calls = 0;
		const html = '<main><h1>Image post</h1><img src="/post.jpg" alt="A detailed primary post image"></main>';
		const result = await executeWebFetch(
			{ url: "https://example.com/post" },
			runtime(async () => {
				calls += 1;
				return httpResponse(200, html, { "content-type": "text/html" });
			}, 100000, false, "api_no_tool_image_output"),
		);
		expect(calls).toBe(1);
		expect(result.details).toMatchObject({
			status: "success",
			completeness: "partial",
			omissions: [{ kind: "primary_media", reason: "api_no_tool_image_output" }],
			media: { discovered: 1, returned: 0 },
		});
		expect(result.content).toContain('partial="api_no_tool_image_output"');
	});

	it("media.mode=off 时不下载已发现主图", async () => {
		let calls = 0;
		const html = '<main><h1>Image post</h1><img src="/post.jpg" alt="A detailed primary post image"></main>';
		const rt = runtime(async () => {
			calls += 1;
			return httpResponse(200, html, { "content-type": "text/html" });
		}, 100000, true);
		rt.config.webfetch.media.mode = "off";
		const result = await executeWebFetch({ url: "https://example.com/post" }, rt);
		expect(calls).toBe(1);
		expect(result.details).toMatchObject({
			status: "success",
			completeness: "partial",
			omissions: [{ kind: "primary_media", reason: "media_disabled" }],
			media: { discovered: 1, returned: 0 },
		});
	});

	it("直接图片响应复用已下载字节，不发起二次请求", async () => {
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
		let calls = 0;
		const result = await executeWebFetch(
			{ url: "https://example.com/direct.png" },
			runtime(async () => {
				calls += 1;
				return httpResponse(200, png, { "content-type": "application/octet-stream" });
			}, 100000, true),
		);
		expect(calls).toBe(1);
		expect(result.details).toMatchObject({
			status: "success",
			scope: "static_response",
			page_kind: "image",
			text_source: "metadata",
			format: "image",
			completeness: "complete",
			omissions: [],
			media: { discovered: 1, returned: 1 },
		});
		expect(result.media?.[0]).toMatchObject({
			mimeType: "image/png",
			sourceUrl: "https://example.com/direct.png",
		});
		expect(result.media?.[0]?.data).toEqual(Uint8Array.from(png));
	});

	it("模型不支持图像时直接图片不产生二次请求并报告遗漏", async () => {
		const gif = Buffer.from("R0lGODlhAQABAAAAACw=", "base64");
		let calls = 0;
		const result = await executeWebFetch(
			{ url: "https://example.com/direct.gif" },
			runtime(async () => {
				calls += 1;
				return httpResponse(200, gif, { "content-type": "image/gif" });
			}),
		);
		expect(calls).toBe(1);
		expect(result.media).toBeUndefined();
		expect(result.details).toMatchObject({
			status: "success",
			format: "image",
			completeness: "partial",
			omissions: [{ kind: "primary_media", reason: "model_no_image_input" }],
			media: { discovered: 1, returned: 0 },
		});
	});

	it("直接图片声明与嗅探不匹配时拒绝为图片", async () => {
		const result = await executeWebFetch(
			{ url: "https://example.com/not-image.png" },
			runtime(async () => httpResponse(200, "not an image", { "content-type": "image/png" }), 100000, true),
		);
		expect(result.details).toMatchObject({
			status: "failed",
			error: { code: "UNSUPPORTED_CONTENT_TYPE" },
		});
		expect(result.media).toBeUndefined();
	});

	it("直接图片响应使用独立大小上限", async () => {
		const rt = runtime(
			async () => httpResponse(200, "short", { "content-type": "image/png", "content-length": "65537" }),
			100000,
			true,
		);
		rt.config.webfetch.media.response_bytes = 65536;
		const result = await executeWebFetch({ url: "https://example.com/too-large.png" }, rt);
		expect(result.details).toMatchObject({
			status: "failed",
			error: { code: "RESPONSE_TOO_LARGE" },
		});
		expect(result.media).toBeUndefined();
	});

	it("主图 redirect 到私网时由共享安全链拒绝且不访问目标", async () => {
		const html = '<main><h1>Image post</h1><img src="/poster.png" alt="A detailed primary post image"></main>';
		const requests: string[] = [];
		const result = await executeWebFetch(
			{ url: "https://example.com/post" },
			runtime(async (url) => {
				requests.push(url.toString());
				if (url.pathname === "/poster.png") {
					return {
						status: 302,
						statusText: "Found",
						headers: new Headers({ location: "http://127.0.0.1/private.png" }),
						body: httpResponse(200, "").body,
					};
				}
				return httpResponse(200, html, { "content-type": "text/html" });
			}, 100000, true),
		);
		expect(requests).toEqual(["https://example.com/post", "https://example.com/poster.png"]);
		expect(result.details).toMatchObject({
			status: "success",
			completeness: "partial",
			omissions: [{ kind: "primary_media", reason: "media_fetch_failed" }],
			media: { discovered: 1, returned: 0 },
		});
		expect(result.media).toBeUndefined();
	});

	it("视频页只下载 poster，不请求视频流并报告视频未返回", async () => {
		const html = `
			<html><head><meta property="og:type" content="video.other"></head>
			<body><main><h1>Video lesson</h1><video poster="/poster.png" src="/movie.mp4"></video></main></body></html>`;
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
		const requests: string[] = [];
		const result = await executeWebFetch(
			{ url: "https://example.com/video" },
			runtime(async (url) => {
				requests.push(url.toString());
				return url.pathname === "/poster.png"
					? httpResponse(200, png, { "content-type": "image/png" })
					: httpResponse(200, html, { "content-type": "text/html" });
			}, 100000, true),
		);
		expect(requests).toEqual(["https://example.com/video", "https://example.com/poster.png"]);
		expect(result.media?.[0]).toMatchObject({ sourceUrl: "https://example.com/poster.png" });
		expect(result.details).toMatchObject({
			status: "success",
			completeness: "partial",
			omissions: [{ kind: "primary_media", reason: "video_not_returned" }],
			media: { discovered: 1, returned: 1 },
		});
		expect(result.content).toContain('partial="video_not_returned"');
	});

	it("音频页只记录媒体存在，不请求音频流", async () => {
		const html = `
			<html><head><meta property="og:type" content="audio.other"></head>
			<body><main><h1>Audio lesson</h1><audio src="/lesson.mp3"></audio></main></body></html>`;
		const requests: string[] = [];
		const result = await executeWebFetch(
			{ url: "https://example.com/audio" },
			runtime(async (url) => {
				requests.push(url.toString());
				return httpResponse(200, html, { "content-type": "text/html" });
			}, 100000, true),
		);
		expect(requests).toEqual(["https://example.com/audio"]);
		expect(result.media).toBeUndefined();
		expect(result.details).toMatchObject({
			status: "success",
			completeness: "partial",
			omissions: [{ kind: "primary_media", reason: "audio_not_returned" }],
			media: { discovered: 0, returned: 0 },
		});
	});

	it.each([
		{
			name: "响应超过独立图片上限",
			imageResponse: () => httpResponse(200, "short", { "content-type": "image/png", "content-length": "65537" }),
			expectedReason: "media_too_large",
		},
		{
			name: "响应内容不是受支持的图片",
			imageResponse: () => httpResponse(200, "not an image", { "content-type": "image/png" }),
			expectedReason: "unsupported_media_type",
		},
	])("主图$name时报告遗漏且不返回字节", async ({ imageResponse, expectedReason }) => {
		const html = '<main><h1>Image post</h1><img src="/post.png" alt="A detailed primary post image"></main>';
		let calls = 0;
		const rt = runtime(async () => {
			calls += 1;
			return calls === 1 ? httpResponse(200, html, { "content-type": "text/html" }) : imageResponse();
		}, 100000, true);
		rt.config.webfetch.media.response_bytes = 65536;
		const result = await executeWebFetch({ url: "https://example.com/post" }, rt);
		expect(calls).toBe(2);
		expect(result.media).toBeUndefined();
		expect(result.details).toMatchObject({
			status: "success",
			completeness: "partial",
			omissions: [{ kind: "primary_media", reason: expectedReason }],
			media: { discovered: 1, returned: 0 },
		});
	});

	it("未解析的声明式延迟内容和分段文本都会进入 completeness 契约", async () => {
		const html = `<main><h1>Post</h1><p>${"Visible ".repeat(20)}</p></main><template for="missing"><p>Hidden reply</p></template>`;
		const result = await executeWebFetch(
			{ url: "https://example.com/post", limit: 20 },
			runtime(async () => httpResponse(200, html, { "content-type": "text/html" })),
		);
		expect(result.details).toMatchObject({
			status: "success",
			completeness: "partial",
			deferred_fragments: { discovered: 1, resolved: 0 },
		});
		if (result.details.status !== "success") throw new Error("failed");
		expect(result.details.omissions).toEqual(expect.arrayContaining([
			{ kind: "text_range", reason: "range" },
			{ kind: "deferred_content", reason: "unresolved_declaration" },
		]));
		expect(result.content).not.toContain("Hidden reply");
	});

	it("文章正文无已知遗漏时报告静态范围内 complete，并标注正文来源", async () => {
		const html = `
			<html><head><meta property="og:type" content="article"></head><body>
				<article><h1>Static article</h1><p>Complete article body with enough stable content for selection.</p></article>
				<script src="/ordinary-enhancement.js"></script>
			</body></html>`;
		const result = await executeWebFetch(
			{ url: "https://example.com/article" },
			runtime(async () => httpResponse(200, html, { "content-type": "text/html" })),
		);
		expect(result.details).toMatchObject({
			status: "success",
			scope: "static_response",
			page_kind: "article",
			text_source: "semantic",
			completeness: "complete",
			omissions: [],
		});
		expect(result.content).toContain('<webfetch kind="article">');
		expect(result.content).not.toContain("scope=");
		expect(result.content).not.toContain("source=");
		expect(result.content).not.toContain("partial=");
	});

	it("iframe 和客户端空壳进入完整性契约，但普通脚本本身不导致 partial", async () => {
		const article = `
			<html><head><meta property="og:type" content="article"></head><body>
				<article><h1>Embedded article</h1><p>Static article content remains available.</p>
					<iframe src="https://player.example/video"></iframe>
				</article>
			</body></html>`;
		const embedded = await executeWebFetch(
			{ url: "https://example.com/embedded" },
			runtime(async () => httpResponse(200, article, { "content-type": "text/html" })),
		);
		expect(embedded.details).toMatchObject({
			status: "success",
			page_kind: "article",
			completeness: "partial",
			omissions: [{ kind: "embedded_content", reason: "iframe_not_fetched" }],
		});
		expect(embedded.content).toContain('partial="iframe_not_fetched"');

		const shell = `
			<html><head><title>Client shell</title><meta name="description" content="Only metadata is available."></head>
			<body><div id="app"></div><script src="/app.js"></script></body></html>`;
		const clientRendered = await executeWebFetch(
			{ url: "https://example.com/app" },
			runtime(async () => httpResponse(200, shell, { "content-type": "text/html" })),
		);
		expect(clientRendered.details).toMatchObject({
			status: "success",
			page_kind: "generic",
			text_source: "metadata",
			completeness: "partial",
			omissions: [{ kind: "interactive_content", reason: "client_rendered" }],
		});
		expect(clientRendered.content).toContain('kind="generic" source="metadata" partial="client_rendered"');
	});

	it("snapshot 只保存正文与分析摘要，分页保留页面类型和静态 omission", async () => {
		const html = `
			<html><head><meta property="og:type" content="video.other"></head><body>
				<main><h1>Long video page</h1><p>${"Static transcript paragraph. ".repeat(100)}</p>
					<iframe src="https://player.example/embed"></iframe>
				</main>
			</body></html>`;
		const rt = runtime(async () => httpResponse(200, html, { "content-type": "text/html" }));
		const setSnapshot = vi.spyOn(rt.snapshots, "set");
		const first = await executeWebFetch({ url: "https://example.com/video", limit: 120 }, rt);
		if (first.details.status !== "success") throw new Error("failed");
		const nextOffset = first.details.range.next_offset;
		if (nextOffset === undefined) throw new Error("missing next offset");
		expect(setSnapshot).toHaveBeenCalledTimes(1);
		const snapshot = setSnapshot.mock.calls[0]?.[0];
		expect(snapshot?.metadata).toHaveProperty("analysis");
		expect(snapshot?.metadata).not.toHaveProperty("extraction");
		expect(JSON.stringify(snapshot)).not.toContain("mediaCandidates");
		expect(JSON.stringify(snapshot)).not.toContain('"data"');

		const second = await executeWebFetch(
			{ url: "https://example.com/video", offset: nextOffset, limit: 120 },
			rt,
		);
		expect(second.details).toMatchObject({
			status: "success",
			snapshot: "hit",
			scope: "static_response",
			page_kind: "video",
			text_source: first.details.text_source,
			completeness: "partial",
		});
		if (second.details.status !== "success") throw new Error("failed");
		expect(second.details.omissions).toEqual(expect.arrayContaining([
			{ kind: "text_range", reason: "range" },
			{ kind: "embedded_content", reason: "iframe_not_fetched" },
			{ kind: "primary_media", reason: "video_not_returned" },
		]));
		expect(second.content).toContain('partial="range,iframe_not_fetched,video_not_returned"');
		expect(second.content).not.toContain("<omitted");
	});
});

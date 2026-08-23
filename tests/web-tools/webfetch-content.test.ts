import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { convertContent } from "../../src/web-tools/content/content-converter.js";
import type { ContentConversion, WebFetchFailureDetails } from "../../src/web-tools/core/types.js";

const readability = { charThreshold: 500 };

function headers(contentType: string): Headers {
	return new Headers({ "content-type": contentType });
}

function occurrences(value: string, needle: string): number {
	return value.split(needle).length - 1;
}

function expectText(value: string, expected: { includes?: readonly string[]; excludes?: readonly string[] }): void {
	for (const item of expected.includes ?? []) expect(value).toContain(item);
	for (const item of expected.excludes ?? []) expect(value).not.toContain(item);
}

async function fixture(name: string): Promise<string> {
	return readFile(new URL(`./fixtures/webfetch/${name}`, import.meta.url), "utf8");
}

function expectConversionSuccess(result: ContentConversion | WebFetchFailureDetails): ContentConversion {
	if ("status" in result) throw new Error(result.error.message);
	return result;
}

async function convertHtml(html: string, url: string): Promise<ContentConversion> {
	return expectConversionSuccess(
		await convertContent(Buffer.from(html), headers("text/html"), url, "readable", readability, true),
	);
}

describe("webfetch content conversion", () => {
	it("HTML 清理后转 Markdown，选择 article 并绝对化链接", async () => {
		const html = `
			<html><head><title>Doc</title><script>bad()</script></head>
			<body><nav>nav</nav><article><h1>Title</h1><p>See <a href="/guide">guide</a>.</p>${"x".repeat(220)}</article></body></html>`;
		const result = expectConversionSuccess(
			await convertContent(Buffer.from(html), headers("text/html; charset=utf-8"), "https://example.com/docs/page", "readable", readability, true),
		);
		expect(result).toMatchObject({ format: "markdown", title: "Title", charset: "utf-8" });
		expectText(result.text, { includes: ["# Title", "https://example.com/guide"], excludes: ["bad()", "nav"] });
	});

	it("用作者结构过滤头像链接，不依赖图片 URL 或 alt 关键词", async () => {
		const html = `
			<html><body><article>
				<h1>Discussion</h1>
				<section>
					<a href="/user/alice"><img src="/assets/opaque-a.png" width="48" height="48" alt="Alice"></a>
					<a href="/user/alice">Alice</a>
					<p>${"Alice wrote a useful technical comment. ".repeat(12)}</p>
				</section>
				<section itemprop="author" itemscope itemtype="https://schema.org/Person">
					<a itemprop="url" href="/people/bob"><img itemprop="image" src="/assets/opaque-b.png" alt="Bob"></a>
					<a itemprop="url" href="/people/bob"><span itemprop="name">Bob</span></a>
					<p>${"Bob added independent supporting details. ".repeat(12)}</p>
				</section>
				<img class="member-avatar" src="/assets/opaque-c.png" alt="Member photo">
				<a href="/guides/avatar-parsing">
					<img class="avatar-art" src="/images/avatar-parsing.png" width="640" height="360" alt="Avatar parsing diagram">
				</a>
				<a href="/guides/avatar-parsing">Avatar parsing guide</a>
			</article></body></html>`;
		const result = await convertHtml(html, "https://example.com/thread");
		expectText(result.text, {
			includes: ["[Alice](https://example.com/user/alice)", "[Bob](https://example.com/people/bob)"],
			excludes: ["opaque-a.png", "opaque-b.png", "opaque-c.png"],
		});
		expect(occurrences(result.text, "https://example.com/user/alice")).toBe(1);
		expect(occurrences(result.text, "https://example.com/people/bob")).toBe(1);
		expect(result.text).toContain("https://example.com/images/avatar-parsing.png");
	});

	it("对延迟正文应用同一头像过滤链", async () => {
		const html = `
			<html><body>
				<main><h1>Deferred discussion</h1><div id="comments">Loading</div></main>
				<template for="comments">
					<section>
						<a href="/u/carol"><img src="/assets/carol-photo.png" style="width: 40px; height: 40px" alt="Carol"></a>
						<a href="/u/carol">Carol</a>
						<p>Deferred comment body remains visible.</p>
					</section>
				</template>
			</body></html>`;
		const result = await convertHtml(html, "https://example.com/thread");
		expectText(result.text, {
			includes: ["Deferred comment body remains visible.", "[Carol](https://example.com/u/carol)"],
			excludes: ["carol-photo.png"],
		});
		expect(occurrences(result.text, "https://example.com/u/carol")).toBe(1);
	});

	it("source 模式返回原始解码文本", async () => {
		const loadHtml = vi.fn(async () => {
			throw new Error("HTML converter must remain unloaded");
		});
		const result = expectConversionSuccess(
			await convertContent(Buffer.from("<h1>A</h1>"), headers('text/html; charset="utf-8"'), "https://example.com/", "source", readability, true, loadHtml),
		);
		expect(result).toMatchObject({ format: "source" });
		expect(loadHtml).not.toHaveBeenCalled();
		expect(result.text).toBe("<h1>A</h1>");
	});

	it.each([
		["JSON", '{"value":1}', "application/json", "json"],
		["XML", "<root/>", "application/xml", "xml"],
		["普通文本", "plain body", "text/plain", "text"],
	] as const)("%s readable 路径不加载 HTML 转换链", async (_name, body, contentType, format) => {
		const loadHtml = vi.fn(async () => {
			throw new Error("HTML converter must remain unloaded");
		});
		const result = await convertContent(
			Buffer.from(body),
			headers(contentType),
			"https://example.com/content",
			"readable",
			readability,
			true,
			loadHtml,
		);
		expect(result).toMatchObject({ format, text: body });
		expect(loadHtml).not.toHaveBeenCalled();
	});

	it(".html URL 在 readable 模式下即使响应头误报也抽取正文", async () => {
		const html = "<html><head><title>Doc</title></head><body><nav>nav</nav><article><h1>Title</h1><p>Body</p></article></body></html>";
		const textResult = expectConversionSuccess(
			await convertContent(Buffer.from(html), headers("text/plain"), "https://example.com/docs/page.html", "readable", readability, true),
		);
		expect(textResult).toMatchObject({ format: "markdown", contentType: "text/plain", title: "Title" });
		expectText(textResult.text, { includes: ["# Title"], excludes: ["<article>", "nav"] });

		const binaryResult = expectConversionSuccess(
			await convertContent(Buffer.from(html), headers("application/octet-stream"), "https://example.com/docs/page.html", "readable", readability, true),
		);
		expect(binaryResult).toMatchObject({ format: "markdown", contentType: "application/octet-stream" });
		expectText(binaryResult.text, { includes: ["Body"], excludes: ["<html>"] });
	});

	it("把配置的 charThreshold 传给 HTML 转换器", async () => {
		const htmlToMarkdown = vi.fn(() => ({
			text: "ok",
			format: "markdown" as const,
			analysis: {
				pageKind: "generic" as const,
				textSource: "body" as const,
				omissions: [],
				deferredFragments: { discovered: 0, resolved: 0, limited: false },
			},
		}));
		await convertContent(
			Buffer.from("<main><p>Body</p></main>"),
			headers("text/html"),
			"https://example.com/page",
			"readable",
			{ charThreshold: 800 },
			true,
			async () => ({ htmlToMarkdown }),
		);
		expect(htmlToMarkdown).toHaveBeenCalledWith(
			"<main><p>Body</p></main>",
			"https://example.com/page",
			"text/html",
			{ charThreshold: 800 },
			"utf-8",
			true,
		);
	});

	it("拒绝 PDF 和 NUL 二进制", async () => {
		expect(await convertContent(Buffer.from("%PDF-1.7"), headers("application/pdf"), "https://example.com/a.pdf", "readable", readability, true)).toMatchObject({
			status: "failed",
			error: { code: "UNSUPPORTED_CONTENT_TYPE" },
		});
		expect(await convertContent(Buffer.from([65, 0, 66]), headers("text/plain"), "https://example.com/a.txt", "readable", readability, true)).toMatchObject({
			status: "failed",
			error: { code: "UNSUPPORTED_CONTENT_TYPE" },
		});
	});

	it("拒绝非法 Content-Type header", async () => {
		expect(await convertContent(Buffer.from("x"), headers("bad header"), "https://example.com/a.txt", "readable", readability, true)).toMatchObject({
			status: "failed",
			error: { code: "UNSUPPORTED_CONTENT_TYPE" },
		});
	});

	it("不可阅读页面回退到 main，不让长侧栏取代短媒体正文", async () => {
		const html = `
			<html><head><title>Generic site title</title></head><body>
				<main><h1>Primary media post</h1><img src="/media.jpg" alt="Primary media"></main>
				<aside><h2>Community rules</h2><ul>${"<li>Long sidebar rule</li>".repeat(80)}</ul></aside>
			</body></html>`;
		const result = await convertHtml(html, "https://example.com/post");
		expect(result).toMatchObject({ format: "markdown", title: "Primary media post" });
		expect(result.text).toContain("# Primary media post");
		expect(result.text).toContain("https://example.com/media.jpg");
		expect(result.text).not.toContain("Long sidebar rule");
	});

	it("Readability 选中与唯一主标题无关的区域时回退到 main", async () => {
		const html = `
			<html><body>
				<main><h1>Primary media post</h1><img src="/media.jpg" alt="Primary media"></main>
				<section><p>${"Competing prose outside the semantic main. ".repeat(30)}</p></section>
			</body></html>`;
		const result = await convertHtml(html, "https://example.com/post");
		expect(result).toMatchObject({ format: "markdown", title: "Primary media post" });
		expect(result.text).toContain("# Primary media post");
		expect(result.text).not.toContain("Competing prose");
	});

	it("延迟长文被 Readability 选为正文时仍合并原始主内容", async () => {
		const html = `
			<html><body>
				<main>
					<h1>Original media post</h1>
					<img src="/post.jpg" alt="Detailed original post image">
					<div id="replies">Loading replies</div>
				</main>
				<template for="replies">
					<section><h2>Replies</h2><p>${"Long deferred discussion. ".repeat(80)}</p></section>
				</template>
			</body></html>`;
		const result = await convertHtml(html, "https://example.com/post");
		expect(result.title).toBe("Original media post");
		expect(result.text).toContain("# Original media post");
		expect(result.text).toContain("Long deferred discussion");
		expect(result.text).not.toContain("Loading replies");
	});

	it("基础帖子与 template[for] 评论分区保留，并清理通用交互控件", async () => {
		const result = await convertHtml(await fixture("deferred-template.html"), "https://example.com/discussion");
		expect(result.text).toContain("# Image discussion");
		expect(result.text).toContain("Original post summary.");
		expect(result.text).toContain("Legitimate similarly named content.");
		expect(result.text).toContain("https://example.com/post.jpg");
		expect(result.text).toContain("## Deferred content");
		expect(result.text).toContain("First useful deferred comment.");
		expect(result.text).not.toContain("Loading comments");
		expect(result.text).not.toContain("Join the conversation");
		expect(result.text).not.toContain("Newest");
		expect(result.text).not.toContain("Unmatched ordinary template content.");
		expect(result.text).not.toContain("Unsafe composer");
	});

	it("展开声明式 Shadow DOM，包括受深度限制的嵌套内容", async () => {
		const result = await convertHtml(await fixture("declarative-shadow-dom.html"), "https://example.com/components");
		expect(result.text).toContain("Stable light DOM introduction.");
		expect(result.text).toContain("## Deferred content");
		expect(result.text).toContain("Visible declarative shadow content.");
		expect(result.text).toContain("Nested declarative shadow detail.");
	});

	it("提取 body noscript fallback，并过滤危险节点与跟踪像素", async () => {
		const result = await convertHtml(await fixture("noscript-fallback.html"), "https://example.com/fallback");
		expect(result.text).toContain("# Static fallback");
		expect(result.text).toContain("Useful fallback article body.");
		expect(result.text).toContain("https://example.com/diagram.png");
		expect(result.text).not.toContain("tracking.gif");
		expect(result.text).not.toContain("bad()");
		expect(result.text).not.toContain("Unsafe form");
		expect(result.text).not.toContain("frame.example");
	});

	it("为缺失、重复和循环 template 目标记录稳定跳过原因", async () => {
		const html = `
			<html><body>
				<main><h1>Bounded declarations</h1><div id="slot">Loading</div></main>
				<template for="slot"><p>Resolved once</p></template>
				<template for="slot"><p>Duplicate</p></template>
				<template for="missing"><p>Missing</p></template>
				<div id="cycle"><template for="cycle"><p>Cycle</p></template></div>
			</body></html>`;
		const result = await convertHtml(html, "https://example.com/bounded");
		expect(result.text).toContain("Resolved once");
		expect(result.text).not.toContain("Duplicate");
		expect(result.text).not.toContain("Missing");
		expect(result.text).not.toContain("Cycle");
	});

	it("拒绝歧义或无效声明，并在延迟根内展开 linked template 与 noscript", async () => {
		const html = `
			<html>
				<head><noscript><p>Head fallback must stay ignored.</p></noscript></head>
				<body>
					<main><h1>Declaration diagnostics</h1><div id="ambiguous"></div><div id="ambiguous"></div></main>
					<template for=""><p>Empty target</p></template>
					<template for="ambiguous"><p>Ambiguous target</p></template>
					<template for="unused" shadowrootmode="open"><p>Conflicting declaration</p></template>
					<template shadowrootmode="invalid"><p>Invalid shadow mode</p></template>
					<template shadowrootmode="open">
						<section>
							<div id="nested">Loading nested</div>
							<template for="nested"><p>Nested linked content.</p></template>
							<noscript><p>Nested noscript content.</p></noscript>
						</section>
					</template>
				</body>
			</html>`;
		const result = await convertHtml(html, "https://example.com/diagnostics");
		expect(result.text).toContain("Nested linked content.");
		expect(result.text).toContain("Nested noscript content.");
		expect(result.text).not.toContain("Loading nested");
		expect(result.text).not.toContain("Head fallback must stay ignored.");
		expect(result.text).not.toContain("Empty target");
		expect(result.text).not.toContain("Ambiguous target");
		expect(result.text).not.toContain("Conflicting declaration");
		expect(result.text).not.toContain("Invalid shadow mode");
	});

	it("限制声明片段数量且不会重复或崩溃", async () => {
		const manyShadows = Array.from(
			{ length: 70 },
			(_, index) => `<x-fragment><template shadowrootmode="open"><p>Fragment ${index}</p></template></x-fragment>`,
		).join("");
		const html = `<html><body><main><h1>Limits</h1></main>${manyShadows}</body></html>`;
		const result = await convertHtml(html, "https://example.com/limits");
		expect(result.text).toContain("Fragment 0");
		expect(result.text).not.toContain("Fragment 69");
		expect(result.analysis.deferredFragments.limited).toBe(true);
	});

	it("超过声明式嵌套深度时删除更深内容并标记上限", async () => {
		const nested = `${'<x-depth><template shadowrootmode="open">'.repeat(10)}
			<p>Too deeply nested</p>
			${"</template></x-depth>".repeat(10)}`;
		const html = `<html><body><main><h1>Depth limit</h1></main>${nested}</body></html>`;
		const result = await convertHtml(html, "https://example.com/depth");
		expect(result.text).not.toContain("Too deeply nested");
		expect(result.analysis.deferredFragments.limited).toBe(true);
	});

	it("使用 Open Graph、Twitter、base 和 DOM 媒体信号", async () => {
		const html = `
			<html><head>
				<base href="https://cdn.example.com/assets/">
				<title>Document title</title>
				<meta name="description" content="Document description">
				<meta property="og:title" content="Open Graph title">
				<meta property="og:description" content="Open Graph description">
				<meta property="og:type" content="video.other">
				<meta property="og:image" content="cover.jpg">
				<meta property="og:image:secure_url" content="https://secure.example.com/cover.jpg">
				<meta property="og:image:type" content="image/jpeg">
				<meta property="og:image:width" content="1280">
				<meta property="og:image:height" content="720">
				<meta property="og:image:alt" content="Video cover">
				<meta property="og:video" content="movie.mp4">
				<meta property="og:audio" content="sound.mp3">
				<meta name="twitter:card" content="summary_large_image">
				<meta name="twitter:title" content="Twitter title">
				<meta name="twitter:description" content="Twitter description">
				<meta name="twitter:image" content="twitter.jpg">
			</head><body>
				<h1>Visible heading</h1>
				<video src="clip.mp4" poster="poster.jpg"><source src="clip-hd.mp4" type="video/mp4"></video>
				<audio src="audio.mp3"><source src="audio.ogg" type="audio/ogg"></audio>
				<picture><source src="wide.webp" type="image/webp"></picture>
			</body></html>`;
		const result = await convertHtml(html, "https://example.com/pages/index");
		expect(result.title).toBe("Visible heading");
	});

	it("统一正文、srcset 和标准元数据候选，去重后选择正文主图而非 logo 或头像", async () => {
		const html = `
			<html><head>
				<meta property="og:image" content="/hero-1280.webp">
				<meta property="og:image:width" content="1280">
				<meta property="og:image:height" content="720">
			</head><body>
				<header><img src="/brand-logo.png" width="320" height="80" alt="Company logo"></header>
				<article>
					<h1>Field report</h1>
					<p>${"Verified report body. ".repeat(30)}</p>
					<picture>
						<source srcset="/hero-640.webp 640w, /hero-1280.webp 1280w" type="image/webp">
						<img src="/hero-fallback.jpg" srcset="/hero-small.jpg 480w, /hero-large.jpg 1600w"
							width="1280" height="720" alt="Field report overview">
					</picture>
					<img class="author-avatar" src="/profile.png" width="160" height="160" alt="Author avatar">
				</article>
			</body></html>`;
		const result = await convertHtml(html, "https://example.com/report");
		expect(result.analysis.primaryMedia).toEqual({ url: "https://example.com/hero-1280.webp" });
	});

	it("普通页面只有 logo 或头像时不选择主图", async () => {
		const html = `
			<html><body><main>
				<h1>Organization profile</h1>
				<p>${"Organization reference text. ".repeat(20)}</p>
				<img class="site-logo" src="/logo.png" width="400" height="100" alt="Organization logo">
				<img class="profile-avatar" src="/avatar.jpg" width="192" height="192" alt="User avatar">
			</main></body></html>`;
		const result = await convertHtml(html, "https://example.com/about");
		expect(result.analysis.primaryMedia).toBeUndefined();
	});

	it("media.mode=off 时跳过 HTML 图片候选且不产生媒体遗漏", async () => {
		const html = `<main><h1>Image page</h1><p>Stable page body.</p><img src="/cover.jpg" width="1200" height="800"></main>`;
		const result = expectConversionSuccess(
			await convertContent(Buffer.from(html), headers("text/html"), "https://example.com/image", "readable", readability, false),
		);
		expect(result.analysis).toMatchObject({
			pageKind: "image",
			textSource: "semantic",
			omissions: [],
			deferredFragments: { discovered: 0, resolved: 0, limited: false },
		});
		expect(result.analysis.primaryMedia).toBeUndefined();
	});

	it("解析 JSON-LD 对象、数组和 @graph，只提取已知字段", async () => {
		const html = `
			<html><head>
				<title>Fallback title</title>
				<script type="application/ld+json">
					[
						{"@type":"WebSite","name":"Ignored site shell"},
						{"@graph":[
							{
								"@type":"VideoObject",
								"name":"Structured video",
								"description":"Structured description",
								"author":[{"@type":"Person","name":"Alice"},"Studio"],
								"datePublished":"2026-07-20",
								"thumbnailUrl":["/thumb.jpg",{"@type":"ImageObject","url":"/thumb-2.jpg","width":640,"height":360}],
								"contentUrl":"/video.mp4",
								"embedUrl":"https://player.example.com/embed/42",
								"transcript":"Structured transcript"
							}
						]}
					]
				</script>
			</head><body></body></html>`;
		const result = await convertHtml(html, "https://example.com/watch/42");
		expect(result.title).toBe("Structured video");
		expect(result.text).toContain("# Structured video");
		expect(result.text).toContain("Structured description");
	});

	it("无效或超限 JSON-LD 产生通用遗漏，SPA 空壳回退到标准元数据", async () => {
		const oversized = JSON.stringify({ "@type": "Article", articleBody: "x".repeat(300_000) });
		const html = `
			<html><head>
				<title>Shell title</title>
				<meta name="description" content="Shell description">
				<meta property="og:title" content="Shell Open Graph title">
				<script type="application/ld+json">{"broken":</script>
				<script type="application/ld+json">${oversized}</script>
			</head><body><div id="app"></div><script src="/app.js"></script></body></html>`;
		const result = await convertHtml(html, "https://example.com/app");
		expect(result).toMatchObject({ title: "Shell Open Graph title", format: "markdown" });
		expect(result.text).toContain("# Shell Open Graph title");
		expect(result.text).toContain("Shell description");
		expect(result.analysis.omissions).toContainEqual({ kind: "structured_data", reason: "invalid_or_limited" });
	});

	it("JSON-LD 对象数和递归深度超限时停止分析并保留页面正文", async () => {
		const manyObjects = JSON.stringify(Array.from({ length: 520 }, (_, index) => ({ name: `node-${index}` })));
		let deeplyNested = '{"child":'.repeat(24);
		deeplyNested += '{"@type":"Article","articleBody":"must not be extracted"}';
		deeplyNested += "}".repeat(24);
		const html = `
			<html><head>
				<script type="application/ld+json">${deeplyNested}</script>
				<script type="application/ld+json">${manyObjects}</script>
			</head><body><main><h1>Visible page</h1><p>Stable body</p></main></body></html>`;
		const result = await convertHtml(html, "https://example.com/page");
		expect(result.text).toContain("Stable body");
		expect(result.text).not.toContain("must not be extracted");
	});

	it("JSON-LD 脚本数和遍历节点数受硬上限约束", async () => {
		const scripts = Array.from(
			{ length: 70 },
			(_, index) => `<script type="application/ld+json">{"@type":"Thing","name":"node-${index}"}</script>`,
		).join("");
		const wideArray = JSON.stringify(Array.from({ length: 3_000 }, () => null));
		const html = `<html><head><script type="application/ld+json">${wideArray}</script>${scripts}</head>
			<body><main><h1>Bounded metadata</h1><p>Visible bounded body.</p></main></body></html>`;
		const result = await convertHtml(html, "https://example.com/bounded-json-ld");
		expect(result.text).toContain("Visible bounded body.");
	});

	it("标题优先级为正文标题、标准元数据标题、document title", async () => {
		const withHeading = await convertHtml(`
				<head>
					<title>Document</title>
					<meta property="og:title" content="Open Graph">
					<script type="application/ld+json">
						{
							"@type":"https://schema.org/Article",
							"headline":"Structured",
							"image":{"@type":"ImageObject","name":"Nested cover","url":"/cover.jpg"}
						}
					</script>
				</head>
				<body><article>
					<h1>Article heading</h1>
					<img src="/illustration.jpg" alt="Detailed article illustration">
					<p>${"Body ".repeat(120)}</p>
				</article></body>
			`, "https://example.com/article");
		expect(withHeading).toMatchObject({ title: "Article heading" });
		expect(withHeading.analysis).toMatchObject({ pageKind: "article", textSource: "readability" });

		const metadataOnly = await convertHtml(`
				<head>
					<title>Document</title>
					<meta property="og:title" content="Open Graph">
					<script type="application/ld+json">{"@type":"Article","headline":"Structured"}</script>
				</head><body></body>
			`, "https://example.com/shell");
		expect(metadataOnly).toMatchObject({
			title: "Open Graph",
			analysis: { textSource: "metadata" },
		});
	});

	it.each([
		{
			name: "semantic",
			html: "<main><h1>Semantic source</h1><p>Short stable semantic body.</p></main>",
			expected: "semantic",
		},
		{
			name: "body fallback after unique h1 signal",
			html: '<div><h1>Heading source</h1><img src="/cover.jpg" alt="Detailed cover"></div>',
			expected: "body",
		},
		{
			name: "body",
			html: "<body><p>Short body fallback without a semantic container.</p></body>",
			expected: "body",
		},
	] as const)("记录 $name 正文来源", async ({ html, expected }) => {
		const result = await convertHtml(html, "https://example.com/source");
		expect(result.analysis.textSource).toBe(expected);
	});

	it("媒体页拒绝导航推荐正文，返回标题、描述和作者元数据", async () => {
		const recommendations = Array.from(
			{ length: 60 },
			(_, index) => `<li><a href="/recommended/${index}">Recommended video ${index}</a></li>`,
		).join("");
		const html = `
			<html><head>
				<title>Generic video portal</title>
				<meta property="og:type" content="video.other">
				<meta property="og:title" content="How the renderer works">
				<meta property="og:description" content="A focused explanation of the rendering pipeline.">
				<meta property="og:image" content="/cover.jpg">
				<script type="application/ld+json">
					{"@type":"VideoObject","name":"How the renderer works","author":{"name":"Alice"},"datePublished":"2026-07-22"}
				</script>
			</head><body>
				<header><a href="/">Home</a><a href="/popular">Popular</a></header>
				<div class="video-info"><h1>How the renderer works</h1><span>12K views</span></div>
				<section class="recommendations"><h2>Recommended</h2><ul>${recommendations}</ul></section>
			</body></html>`;
		const result = await convertHtml(html, "https://example.com/video/42");
		expect(result).toMatchObject({ title: "How the renderer works" });
		expect(result.text).toContain("# How the renderer works");
		expect(result.text).toContain("A focused explanation of the rendering pipeline.");
		expect(result.text).toContain("**Author:** Alice");
		expect(result.text).toContain("**Published:** 2026-07-22");
		expect(result.text).not.toContain("Recommended video");
		expect(result.analysis).toMatchObject({ pageKind: "video", primaryMedia: { url: "https://example.com/cover.jpg" } });
	});

	it("按语义候选质量选择 itemprop articleBody，不混入链接列表", async () => {
		const html = `
			<html><body>
				<section class="toolbar"><a href="/one">One</a><a href="/two">Two</a></section>
				<div itemprop="articleBody">
					<h1>Semantic article</h1>
					<p>${"Substantive paragraph with evidence. ".repeat(30)}</p>
				</div>
				<aside><ul>${'<li><a href="/related">Related item</a></li>'.repeat(80)}</ul></aside>
			</body></html>`;
		const result = await convertHtml(html, "https://example.com/article");
		expect(result.text).toContain("Substantive paragraph with evidence.");
		expect(result.text).not.toContain("Related item");
		expect(result.text).not.toContain("[One]");
	});

	it("无合格 DOM 候选时先使用 JSON-LD articleBody 和 transcript，再放弃 body 链接农场", async () => {
		const links = Array.from(
			{ length: 80 },
			(_, index) => `<li><a href="/item/${index}">Trending item ${index}</a></li>`,
		).join("");
		const html = `
			<html><head>
				<script type="application/ld+json">
					{
						"@type":"Article",
						"headline":"Structured report",
						"description":"Structured report summary.",
						"articleBody":"The structured article body contains the verified findings.",
						"transcript":"The structured transcript contains supporting remarks."
					}
				</script>
			</head><body><div class="trending"><ul>${links}</ul></div></body></html>`;
		const result = await convertHtml(html, "https://example.com/report");
		expect(result.text).toContain("# Structured report");
		expect(result.text).toContain("The structured article body contains the verified findings.");
		expect(result.text).toContain("The structured transcript contains supporting remarks.");
		expect(result.text).not.toContain("Trending item");
		expect(result.text).not.toContain("Structured report summary.");
	});

	it("section 仅按规范化相等和包含关系去重 description 与 transcript", async () => {
		const repeated = "A stable description already present in the article body.";
		const html = `
			<html><head>
				<meta name="description" content="${repeated}">
				<script type="application/ld+json">
					{"@type":"Article","headline":"Deduplicated article","description":"${repeated}","transcript":"${repeated}"}
				</script>
			</head><body><article><h1>Deduplicated article</h1><p>${repeated}</p></article></body></html>`;
		const result = await convertHtml(html, "https://example.com/deduplicated");
		expect(occurrences(result.text, repeated)).toBe(1);
	});

	it("已有短段落正文时 metadata description 不补写到正文", async () => {
		const html = `
			<html><head><meta name="description" content="Metadata summary must remain supplemental."></head>
			<body><article><h1>Short article</h1><p>Brief but complete body.</p></article></body></html>`;
		const result = await convertHtml(html, "https://example.com/short");
		expect(result.text).toContain("Brief but complete body.");
		expect(result.text).not.toContain("Metadata summary must remain supplemental.");
	});

	it("选中正文继续保留 GFM 表格、代码块和绝对链接", async () => {
		const html = `
			<html><body><article>
				<h1>Technical reference</h1>
				<p>${"Technical introduction. ".repeat(30)}</p>
				<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>mode</td><td>safe</td></tr></tbody></table>
				<pre><code class="language-ts">const mode = "safe";</code></pre>
				<p>Read the <a href="/guide">complete guide</a>.</p>
			</article><aside>${"Unrelated sidebar. ".repeat(100)}</aside></body></html>`;
		const result = await convertHtml(html, "https://example.com/reference");
		expect(result.text).toContain("| Name | Value |");
		expect(result.text).toContain("```");
		expect(result.text).toContain('const mode = "safe";');
		expect(result.text).toContain("[complete guide](https://example.com/guide)");
		expect(result.text).not.toContain("Unrelated sidebar");
	});

	it("没有 Readability、语义根、主标题或结构化正文时使用 body fallback", async () => {
		const html = `<html><body><div>${"Plain fallback body text. ".repeat(20)}</div></body></html>`;
		const result = await convertHtml(html, "https://example.com/plain");
		expect(result.text).toContain("Plain fallback body text.");
	});
});

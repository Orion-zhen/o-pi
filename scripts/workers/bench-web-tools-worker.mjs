import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fromRoot, loadTypeScript } from "../benchmark/loader.mjs";

const mode = process.argv[2] ?? "search";
if (mode === "parser") {
	await runParserBenchmark();
} else if (mode === "html") {
	await runHtmlBenchmark(process.argv[3] ?? "article");
} else if (mode === "search" || mode === "fetch" || mode === "fetch-image-skip") {
	await runToolBenchmark(mode);
} else {
	throw new Error("mode must be search, fetch, fetch-image-skip, html, or parser");
}

async function runToolBenchmark(toolMode) {
	process.env.PI_WEB_TOOLS_CONFIG = "/__o_pi_missing_web_tools_benchmark_config__";
	process.env.PI_WEB_TOOLS_COOKIES = "/__o_pi_missing_web_tools_benchmark_cookies__";
	const tools = new Map();
	let imageReads = 0;
	const started = performance.now();
	const extensionModule = await loadTypeScript("agent/extensions/web-tools.ts");
	const extension = extensionModule.createWebToolsExtension(async () => {
		const { createWebToolsRuntime } = await loadTypeScript("src/web-tools/web-tools-runtime.ts");
		return createWebToolsRuntime({
			dispatcher: { close: async () => undefined },
			searchProviders: [{
				id: "brave_api",
				async search(params) {
					return { status: "success", provider: "brave_api", downloadedBytes: 0, results: [{ rank: 1, title: params.query, url: "https://example.com/", snippet: params.query }] };
				},
			}],
			fetchImpl: async () => toolMode === "fetch-image-skip"
				? skippedImageResponse(() => { imageReads += 1; })
				: response("hello benchmark"),
		});
	});
	extension({ registerTool(tool) { tools.set(tool.name, tool); }, on() {} });
	const registered = performance.now();
	const tool = tools.get(toolMode === "search" ? "websearch" : "webfetch");
	if (tool === undefined) throw new Error(`${toolMode} was not registered`);
	const params = toolMode === "search"
		? { query: "pi", limit: 1 }
		: toolMode === "fetch-image-skip"
			? { url: "https://example.com/direct.png" }
			: { url: "https://example.com/", mode: "source" };
	const context = toolMode === "search"
		? {}
		: toolMode === "fetch-image-skip"
			? { hasUI: false, model: { api: "openai-completions", input: ["text", "image"] } }
			: { hasUI: false };
	await tool.execute(`${toolMode}-cold`, params, undefined, undefined, context);
	const firstCompleted = performance.now();
	await tool.execute(`${toolMode}-warm`, params, undefined, undefined, context);
	const warmCompleted = performance.now();
	if (toolMode === "fetch-image-skip" && imageReads !== 0) throw new Error("unsupported image output read response bytes");
	console.log(JSON.stringify({
		registrationMs: registered - started,
		firstToolMs: firstCompleted - registered,
		warmToolMs: warmCompleted - firstCompleted,
		...(toolMode === "fetch-image-skip" ? { imageReads } : {}),
	}));
}

async function runParserBenchmark() {
	const fixture = readFileSync(fromRoot("tests/web-tools/fixtures/websearch/results.html"), "utf8");
	const started = performance.now();
	const module = await loadTypeScript("src/web-tools/duckduckgo-html.ts");
	const imported = performance.now();
	module.parseDuckDuckGoHtml(fixture);
	const firstCompleted = performance.now();
	module.parseDuckDuckGoHtml(fixture);
	const warmCompleted = performance.now();
	console.log(JSON.stringify({ importMs: imported - started, firstParseMs: firstCompleted - imported, warmParseMs: warmCompleted - firstCompleted }));
}

async function runHtmlBenchmark(scenario) {
	const html = htmlFixture(scenario);
	const started = performance.now();
	const module = await loadTypeScript("src/web-tools/html-content-converter.ts");
	const imported = performance.now();
	const result = module.htmlToMarkdown(html, "https://example.com/page", "text/html", { charThreshold: 500 }, "utf-8");
	const completed = performance.now();
	if ("status" in result || result.text.length === 0) throw new Error(`HTML benchmark ${scenario} did not produce content`);
	console.log(JSON.stringify({
		importMs: imported - started,
		conversionMs: completed - imported,
		maxRssMb: process.resourceUsage().maxRSS / 1024,
		inputMb: Buffer.byteLength(html) / 1024 / 1024,
	}));
}

function htmlFixture(scenario) {
	if (scenario === "deferred") {
		const commentBody = "Bounded deferred discussion with stable technical evidence, context, links, and quoted source material. ".repeat(4);
		const comments = Array.from({ length: 10_000 }, (_, index) => `<section><h2>Comment ${index}</h2><p>${commentBody}</p></section>`).join("");
		return `<html><head><meta property="og:title" content="Large discussion"><meta property="og:image" content="/post.jpg"></head><body><main><h1>Large discussion</h1><p>Original static post.</p><div id="comments">Loading</div></main><template for="comments">${comments}</template></body></html>`;
	}
	if (scenario === "video") {
		const recommendations = Array.from({ length: 8_000 }, (_, index) => `<li><a href="/watch/${index}">Recommended media item ${index}</a></li>`).join("");
		return `<html><head><meta property="og:type" content="video.other"><meta property="og:title" content="Static video metadata"><meta property="og:description" content="A focused static description."><meta property="og:image" content="/cover.jpg"></head><body><header><a href="/">Home</a></header><div class="video-info"><h1>Static video metadata</h1><span>Author</span></div><section class="recommendations"><ul>${recommendations}</ul></section></body></html>`;
	}
	if (scenario === "article") {
		const paragraphBody = "contains stable article prose, a concrete fact, and enough context for extraction. ".repeat(3);
		const paragraphs = Array.from({ length: 8_000 }, (_, index) => `<p>Paragraph ${index} ${paragraphBody}</p>`).join("");
		return `<html><head><title>Large article</title></head><body><nav>Navigation</nav><article><h1>Large article</h1>${paragraphs}</article><aside>Related links</aside></body></html>`;
	}
	if (scenario === "hostile") {
		const templates = Array.from({ length: 4_000 }, (_, index) => `<template for="missing-${index}"><p>Ignored fragment ${index}</p></template>`).join("");
		const invalidJsonLd = Array.from({ length: 80 }, (_, index) => `<script type="application/ld+json">{"broken":${index},</script>`).join("");
		const wideJsonLd = JSON.stringify(Array.from({ length: 60_000 }, () => null));
		return `<html><head>${invalidJsonLd}<script type="application/ld+json">${wideJsonLd}</script></head><body><main><h1>Hostile metadata</h1><p>Visible content survives bounded analysis.</p></main>${templates}</body></html>`;
	}
	throw new Error(`unknown HTML benchmark scenario: ${scenario}`);
}

function skippedImageResponse(onRead) {
	return {
		status: 200,
		statusText: "OK",
		headers: new Headers({ "content-type": "image/png", "content-length": String(4 * 1024 * 1024) }),
		body: {
			getReader() {
				return {
					async read() {
						onRead();
						return { done: false, value: Buffer.alloc(4 * 1024 * 1024) };
					},
					async cancel() {},
				};
			},
			async cancel() {},
		},
	};
}

function response(body) {
	const bytes = Buffer.from(body);
	return {
		status: 200,
		statusText: "OK",
		headers: new Headers({ "content-type": "text/plain; charset=utf-8", "content-length": String(bytes.byteLength) }),
		body: {
			getReader() {
				let sent = false;
				return {
					async read() {
						if (sent) return { done: true };
						sent = true;
						return { done: false, value: bytes };
					},
					async cancel() {},
				};
			},
			async cancel() {},
		},
	};
}

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fromRoot, loadTypeScript } from "../benchmark/loader.mjs";

const mode = process.argv[2] ?? "search";
if (mode === "parser") {
	await runParserBenchmark();
} else if (mode === "search" || mode === "fetch") {
	await runToolBenchmark(mode);
} else {
	throw new Error("mode must be search, fetch, or parser");
}

async function runToolBenchmark(toolMode) {
	process.env.PI_WEB_TOOLS_CONFIG = "/__o_pi_missing_web_tools_benchmark_config__";
	process.env.PI_WEB_TOOLS_COOKIES = "/__o_pi_missing_web_tools_benchmark_cookies__";
	const tools = new Map();
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
			fetchImpl: async () => response("hello benchmark"),
		});
	});
	extension({ registerTool(tool) { tools.set(tool.name, tool); }, on() {} });
	const registered = performance.now();
	const tool = tools.get(toolMode === "search" ? "websearch" : "webfetch");
	if (tool === undefined) throw new Error(`${toolMode} was not registered`);
	const params = toolMode === "search" ? { query: "pi", limit: 1 } : { url: "https://example.com/", mode: "source" };
	const context = toolMode === "search" ? {} : { hasUI: false };
	await tool.execute(`${toolMode}-cold`, params, undefined, undefined, context);
	const firstCompleted = performance.now();
	await tool.execute(`${toolMode}-warm`, params, undefined, undefined, context);
	const warmCompleted = performance.now();
	console.log(JSON.stringify({ registrationMs: registered - started, firstToolMs: firstCompleted - registered, warmToolMs: warmCompleted - firstCompleted }));
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

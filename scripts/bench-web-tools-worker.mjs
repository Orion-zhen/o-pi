import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = fileURLToPath(new URL("../agent/extensions/web-tools.ts", import.meta.url));
const runtimeEntry = fileURLToPath(new URL("../src/web-tools/web-tools-runtime.ts", import.meta.url));
const mode = process.argv[2] ?? "search";
if (mode !== "search" && mode !== "fetch") throw new Error("mode must be search or fetch");
process.env.PI_WEB_TOOLS_CONFIG = "/__o_pi_missing_web_tools_benchmark_config__";
process.env.PI_WEB_TOOLS_COOKIES = "/__o_pi_missing_web_tools_benchmark_cookies__";

const tools = new Map();
const started = performance.now();
const jiti = createJiti(import.meta.url, { moduleCache: false });
const extensionModule = await jiti.import(entry);
const extension = extensionModule.createWebToolsExtension(async () => {
	const { createWebToolsRuntime } = await jiti.import(runtimeEntry);
	return createWebToolsRuntime({
		dispatcher: { close: async () => undefined },
		searchProviders: [{
			id: "exa_mcp",
			async search(params) {
				return {
					status: "success",
					provider: "exa_mcp",
					downloadedBytes: 0,
					results: [{ rank: 1, title: params.query, url: "https://example.com/" }],
				};
			},
		}],
		fetchImpl: async () => response("hello benchmark"),
	});
});
extension({
	registerTool(tool) {
		tools.set(tool.name, tool);
	},
	on() {},
});
const registered = performance.now();
const tool = tools.get(mode === "search" ? "websearch" : "webfetch");
if (tool === undefined) throw new Error(`${mode} was not registered`);
const params = mode === "search" ? { query: "pi", limit: 1 } : { url: "https://example.com/", mode: "source" };
const context = mode === "search" ? {} : { hasUI: false };
await tool.execute(`${mode}-cold`, params, undefined, undefined, context);
const firstCompleted = performance.now();
await tool.execute(`${mode}-warm`, params, undefined, undefined, context);
const warmCompleted = performance.now();
console.log(JSON.stringify({
	registrationMs: registered - started,
	firstToolMs: firstCompleted - registered,
	warmToolMs: warmCompleted - firstCompleted,
}));

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

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

import webTools, { createWebToolsExtension } from "../../agent/extensions/web-tools.js";
import { attachPrivateNetworkGrant, type PrivateNetworkGrant } from "../../src/web-tools/network/private-network-grant.js";
import type { WebFetchExecutionContext, WebFetchParams, WebToolsRuntime } from "../../src/web-tools/core/types.js";
import { registerExtension } from "../helpers/extension.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";
import { webFetchDetails } from "./renderer-fixture.js";

const execFileAsync = promisify(execFile);
const temp = useTempDir("o-pi-web-extension-");
preserveEnv("PI_WEB_TOOLS_CONFIG", "PI_WEB_TOOLS_COOKIES", "BRAVE_SEARCH_API_KEY", "EXA_API_KEY", "TAVILY_API_KEY");

beforeEach(() => {
	process.env.PI_WEB_TOOLS_CONFIG = path.join(temp.path, "missing-config.jsonc");
	process.env.PI_WEB_TOOLS_COOKIES = path.join(temp.path, "missing-cookies.txt");
	delete process.env.BRAVE_SEARCH_API_KEY;
	delete process.env.EXA_API_KEY;
	delete process.env.TAVILY_API_KEY;
});

describe("web-tools extension", () => {
	it("WebFetch URL schema 固定非空和 8192 字符上限", () => {
		const { registered } = registerExtension(webTools);
		const fetch = registered.find((tool) => tool.name === "webfetch");
		if (fetch === undefined) throw new Error("missing webfetch");
		expect(fetch.parameters).toMatchObject({ properties: { url: { minLength: 1, maxLength: 8192 } } });
	});

	it("按顺序注册工具并标记结构化错误", async () => {
		const { registered, handlers } = registerExtension(webTools);
		expect(registered.map((tool) => tool.name)).toEqual(["websearch", "webfetch"]);

		const eventResult = handlers.get("tool_result")?.({
			toolName: "webfetch",
			details: { status: "failed", error: { code: "INVALID_URL", message: "bad" } },
		});
		expect(eventResult).toEqual({ isError: true });
		expect(handlers.get("tool_result")?.({
			toolName: "websearch",
			details: { status: "failed", provider: "duckduckgo_html", error: { code: "PROVIDER_BLOCKED", message: "blocked" } },
		})).toEqual({ isError: true });
		await handlers.get("session_shutdown")?.({});
	});

	it("注册和 session_start 不加载 runtime，并让并发首次执行和 shutdown 复用同一结果", async () => {
		let resolveRuntime: ((runtime: WebToolsRuntime) => void) | undefined;
		const pendingRuntime = new Promise<WebToolsRuntime>((resolve) => {
			resolveRuntime = resolve;
		});
		const close = vi.fn(async () => undefined);
		const runtime: WebToolsRuntime = {
			async search() {
				return successfulSearch("pi", "search");
			},
			async fetch() {
				return {
					content: "fetch",
					details: { status: "failed", error: { code: "INVALID_URL", message: "bad" } },
				};
			},
			close,
		};
		const loadRuntime = vi.fn(() => pendingRuntime);
		const loadRenderers = vi.fn(async () => {
			throw new Error("renderer must not load");
		});
		const extension = createWebToolsExtension(loadRuntime, loadRenderers);
		const { registered, handlers } = registerExtension(extension);

		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("session_shutdown")).toBe(true);
		await handlers.get("session_start")?.({}, { mode: "rpc", ui: { notify() {} } });
		expect(loadRuntime).not.toHaveBeenCalled();
		expect(loadRenderers).not.toHaveBeenCalled();
		expect(registered.every((tool) => tool.renderCall === undefined)).toBe(true);
		const search = registered.find((tool) => tool.name === "websearch");
		const fetch = registered.find((tool) => tool.name === "webfetch");
		if (search === undefined) throw new Error("missing websearch");
		if (fetch === undefined) throw new Error("missing webfetch");
		const searchExecution = search.execute("search-1", { query: "pi" }, undefined, undefined, {});
		const fetchExecution = fetch.execute("fetch-1", { url: "https://example.com/" }, undefined, undefined, { hasUI: false });
		expect(loadRuntime).toHaveBeenCalledTimes(1);
		if (resolveRuntime === undefined) throw new Error("missing runtime resolver");
		resolveRuntime(runtime);
		await expect(searchExecution).resolves.toMatchObject({ content: [{ type: "text", text: "search" }] });
		await expect(fetchExecution).resolves.toMatchObject({ content: [{ type: "text", text: "fetch" }] });
		await handlers.get("session_shutdown")?.({});
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("将 tool hook 附加的私网授权传给 webfetch runtime", async () => {
		const fetch = vi.fn(async () => ({
			content: "private",
			details: { status: "failed" as const, error: { code: "HTTP_ERROR" as const, message: "test" } },
		}));
		const runtime: WebToolsRuntime = {
			fetch,
			async search() { return successfulSearch("q", "search"); },
			async close() {},
		};
		const { registered } = registerExtension(createWebToolsExtension(async () => runtime));
		const tool = registered.find((item) => item.name === "webfetch");
		if (tool === undefined) throw new Error("missing webfetch");
		const params = { url: "http://127.0.0.1:8080/private" };
		const grant: PrivateNetworkGrant = {
			origin: "http://127.0.0.1:8080",
			hostname: "127.0.0.1",
			addresses: [{ address: "127.0.0.1", family: 4 }],
		};
		attachPrivateNetworkGrant(params, grant);

		await tool.execute("fetch-private", params, undefined, undefined, { hasUI: false });
		expect(fetch).toHaveBeenCalledWith(params, expect.objectContaining({ privateNetworkGrant: grant }));
	});

	it("只在模型和 API 都支持工具图片时返回 Pi ImageContent", async () => {
		const fetch = vi.fn(async (_params: WebFetchParams, _context: WebFetchExecutionContext) => ({
			content: "page",
			details: webFetchDetails({
				page_kind: "image", text_source: "metadata", completeness: "complete", omissions: [],
				media: { discovered: 1, returned: 1 },
			}),
			media: [{ data: Uint8Array.from([1, 2, 3]), mimeType: "image/png" }],
		}));
		const runtime: WebToolsRuntime = {
			fetch,
			async search() { return successfulSearch("q", "search"); },
			async close() {},
		};
		const { registered } = registerExtension(createWebToolsExtension(async () => runtime));
		const tool = registered.find((item) => item.name === "webfetch");
		if (tool === undefined) throw new Error("missing webfetch");
		const responsesResult = await tool.execute(
			"fetch-responses-image", { url: "https://example.com/" }, undefined, undefined,
			{ hasUI: false, model: { api: "openai-responses", input: ["text", "image"] } },
		);
		expect(fetch).toHaveBeenCalledWith({ url: "https://example.com/" }, expect.objectContaining({ acceptsImages: true }));
		expect(responsesResult.content).toEqual([
			{ type: "text", text: "page" },
			{ type: "image", data: "AQID", mimeType: "image/png" },
		]);

		const completionsResult = await tool.execute(
			"fetch-completions-image", { url: "https://example.com/" }, undefined, undefined,
			{ hasUI: false, model: { api: "openai-completions", input: ["text", "image"] } },
		);
		expect(fetch).toHaveBeenLastCalledWith(
			{ url: "https://example.com/" },
			expect.objectContaining({ acceptsImages: false, imageOmissionReason: "api_no_tool_image_output" }),
		);
		expect(completionsResult.content).toEqual([{ type: "text", text: "page" }]);
	});

	it("通过 Pi 的 Jiti 加载后首次调用可正常读取配置", { timeout: 30_000 }, async () => {
		const stdout = await runJitiExtension(`
			const search = tools.find((tool) => tool.name === "websearch");
			if (search === undefined) throw new Error("missing websearch");
			const result = await search.execute("jiti-search", { query: "pi" }, undefined, undefined, {});
			console.log(result.content[0].text);
		`, path.join(process.cwd(), "package.json"));
		expect(stdout).toContain("web-tools user config does not match schema.");
		expect(stdout).not.toContain("agentConfigPath");
	});

	it("通过 Pi 的 Jiti 并发首次执行三个 webfetch 时共享配置模块加载", { timeout: 30_000 }, async () => {
		const stdout = await runJitiExtension(`
			const fetch = tools.find((tool) => tool.name === "webfetch");
			if (fetch === undefined) throw new Error("missing webfetch");
			const results = await Promise.all([
				fetch.execute("jiti-fetch-1", { url: "https://example.com/one" }, undefined, undefined, { hasUI: false }),
				fetch.execute("jiti-fetch-2", { url: "https://example.com/two" }, undefined, undefined, { hasUI: false }),
				fetch.execute("jiti-fetch-3", { url: "https://example.com/three" }, undefined, undefined, { hasUI: false }),
			]);
			console.log(JSON.stringify(results.map((result) => ({ content: result.content, details: result.details }))));
		`, path.join(process.cwd(), "package.json"));
		const results = JSON.parse(stdout.trim()) as Array<{
			content: Array<{ text: string }>;
			details: { status: string; error?: { code: string; message: string } };
		}>;
		expect(results).toHaveLength(3);
		expect(results.every((result) => result.details.status === "failed")).toBe(true);
		expect(results.every((result) => result.details.error?.code === "CONFIG_ERROR")).toBe(true);
		expect(new Set(results.map((result) => result.details.error?.message)).size).toBe(1);
		expect(results.every((result) => result.content[0]?.text.includes('code="CONFIG_ERROR"'))).toBe(true);
		expect(results.every((result) => result.details.error?.message.includes("web-tools user config does not match schema."))).toBe(true);
		expect(stdout).not.toContain("agentConfigPath");
	});
});

function successfulSearch(query: string, content: string) {
	return {
		content,
		details: {
			status: "success" as const, query, provider: "exa_api" as const,
			results: [], downloaded_bytes: 0, duration_ms: 0, attempts: [],
		},
	};
}

async function runJitiExtension(body: string, configPath: string): Promise<string> {
	const extensionPath = path.join(process.cwd(), "agent", "extensions", "web-tools.ts");
	const script = `
		import { createEventBus } from "@earendil-works/pi-coding-agent";
		import { createJiti } from "jiti/static";
		const jiti = createJiti(import.meta.url, { moduleCache: false });
		const extension = await jiti.import(${JSON.stringify(extensionPath)}, { default: true });
		const tools = [];
		const handlers = new Map();
		extension({
			events: createEventBus(),
			registerTool(tool) { tools.push(tool); },
			on(name, handler) { handlers.set(name, handler); },
		});
		${body}
		await handlers.get("session_shutdown")?.({});
	`;
	const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
		cwd: process.cwd(),
		env: { ...process.env, PI_WEB_TOOLS_CONFIG: configPath },
	});
	return stdout;
}

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterEach, beforeEach, expect, it } from "vitest";
import webTools from "../../../src/harness/extensions/web-tools.ts";
import { attachPrivateNetworkGrant } from "../../../src/harness/web-tools/network/private-network-grant.ts";
import { registerExtension, type CapturedExtensionTool } from "../../helpers/extension.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("opi-web-extension-");
preserveEnv("PI_WEB_TOOLS_CONFIG", "PI_WEB_TOOLS_COOKIES");
let server: ReturnType<typeof createServer>;
let origin: string;
let extension: ReturnType<typeof registerExtension<CapturedExtensionTool>>;

beforeEach(async () => {
	const pdf = await readFile(new URL("../file-tools/fixtures/read/two-page.pdf", import.meta.url));
	const image = createCanvas(10, 10).toBuffer("image/png");
	server = createServer((request, response) => {
		const pathname = new URL(request.url ?? "/", origin).pathname;
		if (pathname === "/search") response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ web: { results: [
			{ title: "Pi", url: "https://pi.dev/", description: "Pi SDK documentation" },
			{ title: "Pi guide", url: "https://example.org/pi", description: "Pi examples" },
		] } }));
		else if (pathname === "/image") response.writeHead(200, { "content-type": "image/png" }).end(image);
		else if (pathname === "/pdf") response.writeHead(200, { "content-type": "application/pdf" }).end(pdf);
		else response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Alpha needle Ω\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("缺少 HTTP 端口");
	origin = `http://127.0.0.1:${address.port}`;
	process.env.PI_WEB_TOOLS_CONFIG = path.join(temp.path, "web-tools.jsonc");
	process.env.PI_WEB_TOOLS_COOKIES = path.join(temp.path, "cookies.txt");
	await writeFile(process.env.PI_WEB_TOOLS_CONFIG, JSON.stringify({
		network: { proxy: { enabled: true, http_proxy: origin } },
		websearch: {
			brave_api: { endpoint: "http://1.1.1.1/search", api_key: "fixture" },
			exa_api: { enabled: false }, tavily: { enabled: false }, duckduckgo_html: { enabled: false },
		},
		webfetch: { media: { mode: "on" }, cookies: { enabled: false } },
	}));
	extension = registerExtension(webTools);
});
afterEach(async () => {
	await extension.handlers.get("session_shutdown")?.({});
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function execute(name: string, params: Record<string, unknown>, vision = false) {
	const tool = extension.registered.find((tool) => tool.name === name);
	if (!tool) throw new Error(`缺少工具 ${name}`);
	return tool.execute(name, params, undefined, undefined, { hasUI: false, model: { input: vision ? ["text", "image"] : ["text"] } });
}
function approved(pathname: string, extra: Record<string, unknown> = {}) {
	const params = { url: `${origin}${pathname}`, ...extra };
	attachPrivateNetworkGrant(params, { origin, hostname: "127.0.0.1", addresses: [{ address: "127.0.0.1", family: 4 }] });
	return params;
}

it("网页搜索经过真实 HTTP 边界，脚本结果只保留检索证据", async () => {
	const result = await execute("websearch", { query: "Pi", limit: 2 });
	expect(result.isError).toBe(false);
	expect(result.structuredContent).toEqual({ results: [
		{ title: "Pi", url: "https://pi.dev/", snippet: "Pi SDK documentation" },
		{ title: "Pi guide", url: "https://example.org/pi", snippet: "Pi examples" },
	] });
});

it("私网必须获得授权，授权后的查找返回原文，非法 URL 标记失败", async () => {
	expect((await execute("webfetch", { url: `${origin}/text` })).isError).toBe(true);
	const result = await execute("webfetch", approved("/text", { find: "NEEDLE", offset: 0 }));
	expect(result.isError).toBe(false);
	expect(result.content[0]?.text).toContain("needle Ω");
	expect((await execute("webfetch", { url: "not-a-url" })).isError).toBe(true);
});

it.each([false, true])("图片按模型能力返回，PDF 页码与页面图片对应：%s", async (vision) => {
	const image = await execute("webfetch", approved("/image"), vision);
	expect(image.content.filter((block) => block.type === "image")).toHaveLength(vision ? 1 : 0);
	const pdf = await execute("webfetch", approved("/pdf", { mode: "image", pages: "2" }), vision);
	expect(pdf.isError).toBe(!vision);
	if (vision) {
		expect(pdf.content.map((block) => block.type)).toEqual(["text", "text", "image"]);
		expect(pdf.content[1]?.text).toBe("[page 2]");
		expect(pdf.content[2]?.mimeType).toBe("image/png");
	}
});

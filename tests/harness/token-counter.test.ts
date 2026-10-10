import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { countTextTokens, countTextTokensSync, isLocalOrPrivateHttpUrl, REMOTE_TOKEN_CACHE_MAX_ENTRIES } from "../../src/harness/token-counter.ts";

describe("stats token counter", () => {
	it("只允许本地或私网 tokenizer endpoint", () => {
		expect(isLocalOrPrivateHttpUrl("http://localhost:8000/v1")).toBe(true);
		expect(isLocalOrPrivateHttpUrl("http://127.0.0.1:8000")).toBe(true);
		expect(isLocalOrPrivateHttpUrl("http://192.168.1.20:8000")).toBe(true);
		expect(isLocalOrPrivateHttpUrl("https://api.deepseek.com/v1")).toBe(false);
		expect(isLocalOrPrivateHttpUrl("https://api.openai.com/v1")).toBe(false);
	});

	it.each([
		["http://app.localhost:8000/v1", true],
		["http://10.0.0.1", true],
		["http://172.16.0.1", true],
		["http://172.31.255.255", true],
		["http://169.254.1.1", true],
		["http://[::1]:8000/v1", true],
		["https://[fc00::1]", true],
		["http://[fdff::1]", true],
		["http://[fe80::1]", true],
		["http://[febf::1]", true],
		["http://172.15.255.255", false],
		["http://172.32.0.1", false],
		["http://8.8.8.8", false],
		["http://100.64.0.1", false],
		["http://0.0.0.0", false],
		["http://224.0.0.1", false],
		["http://[::]", false],
		["http://[ff02::1]", false],
		["http://[fec0::1]", false],
		["http://[2001:4860:4860::8888]", false],
		["http://[::ffff:8.8.8.8]", false],
		["http://localhost.example.com", false],
		["ftp://127.0.0.1", false],
		["invalid", false],
		[undefined, false],
	])("按地址范围限制 tokenizer: %s -> %s", (url, allowed) => {
		expect(isLocalOrPrivateHttpUrl(url)).toBe(allowed);
	});

	it("本地 /tokenize 可用时优先使用 endpoint", async () => {
		let requests = 0;
		const server = createServer((request, response) => {
			if (request.url !== "/tokenize") {
				response.writeHead(404).end();
				return;
			}
			requests += 1;
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ tokens: [1, 2, 3, 4] }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		try {
			const scope = { baseUrl: `http://127.0.0.1:${port}/v1`, modelId: "local" };
			const counted = await countTextTokens("hello world", scope);
			expect(counted).toMatchObject({ tokens: 4, method: "remote_tokenize", confidence: "high" });
			await countTextTokens("hello world", scope);
			expect(requests).toBe(1);

			for (let index = 0; index < REMOTE_TOKEN_CACHE_MAX_ENTRIES; index += 1) {
				await countTextTokens(`entry-${index}`, scope);
			}
			await countTextTokens("hello world", scope);
			expect(requests).toBe(REMOTE_TOKEN_CACHE_MAX_ENTRIES + 2);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("公网 provider 不触发远程 tokenize，按 provider 规则降级", async () => {
		const deepseek = await countTextTokens("abc中文", { provider: "deepseek", modelId: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1" });
		const qwen = await countTextTokens("hello world", { provider: "dashscope", modelId: "qwen-max" });
		const unknown = await countTextTokens("hello world", { provider: "custom", modelId: "llama" });

		expect(deepseek.method).toBe("deepseek_ratio");
		expect(qwen.method).toBe("cl100k_base");
		expect(unknown.method).toBe("char_ratio");
	});

	it("同步计数不触发网络请求，未知 provider 使用通用 BPE 预算估算", () => {
		const counted = countTextTokensSync("hello world", { provider: "custom", baseUrl: "http://127.0.0.1:9/v1" });
		expect(counted).toMatchObject({ method: "o200k_base", confidence: "low" });
		expect(counted.tokens).toBeGreaterThan(0);
	});
});

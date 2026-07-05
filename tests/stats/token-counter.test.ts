import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { countTextTokens, countTextTokensSync, isLocalOrPrivateHttpUrl } from "../../src/token-counter.js";

describe("stats token counter", () => {
	it("只允许本地或私网 tokenizer endpoint", () => {
		expect(isLocalOrPrivateHttpUrl("http://localhost:8000/v1")).toBe(true);
		expect(isLocalOrPrivateHttpUrl("http://127.0.0.1:8000")).toBe(true);
		expect(isLocalOrPrivateHttpUrl("http://192.168.1.20:8000")).toBe(true);
		expect(isLocalOrPrivateHttpUrl("https://api.deepseek.com/v1")).toBe(false);
		expect(isLocalOrPrivateHttpUrl("https://api.openai.com/v1")).toBe(false);
	});

	it("本地 /tokenize 可用时优先使用 endpoint", async () => {
		const server = createServer((request, response) => {
			if (request.url !== "/tokenize") {
				response.writeHead(404).end();
				return;
			}
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ tokens: [1, 2, 3, 4] }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		try {
			const counted = await countTextTokens("hello world", { baseUrl: `http://127.0.0.1:${port}/v1`, modelId: "local" });
			expect(counted).toMatchObject({ tokens: 4, method: "remote_tokenize", confidence: "high" });
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

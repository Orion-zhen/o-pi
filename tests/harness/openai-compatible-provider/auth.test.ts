import { describe, expect, it, vi } from "vitest";
import { loadProvider } from "./fixtures.ts";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.ts";

const temp = useOpenAICompatibleProviderTestSetup();

describe("openai-compatible-provider auth", () => {
	it("启用请求扩展后仍由 SDK 解析密钥，并按 provider/model/caller 合并请求头", async () => {
		vi.stubEnv("KEY", "sk-test");
		vi.stubEnv("ACCOUNT", "account");
		vi.stubEnv("MODEL_HEADER", "model");
		const { provider, runtime } = await loadProvider(temp.path, {
			apiKey: "$KEY", extraBody: { custom: true },
			headers: { "X-Account": "$ACCOUNT", "X-Value": "provider" },
			models: [{ id: "m", headers: { "X-Value": "$MODEL_HEADER" } }],
		});
		const model = provider.getModels()[0];
		if (!model) throw new Error("provider model missing");
		const requests: { headers: Headers; body: unknown }[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
			return new Response('{"error":"stop"}', { status: 400 });
		});
		for (const headers of [undefined, { "x-value": "caller" }]) {
			for await (const _event of runtime.streamSimple(model, {
				messages: [{ role: "user", content: "test", timestamp: 0 }],
			}, headers ? { headers } : {})) {}
		}
		expect(requests.map(({ headers }) => headers.get("X-Value"))).toEqual(["model", "caller"]);
		for (const { headers, body } of requests) {
			expect(headers.get("Authorization")).toBe("Bearer sk-test");
			expect(headers.get("X-Account")).toBe("account");
			expect(body).toHaveProperty("custom", true);
		}
	});
});

import { describe, expect, it } from "vitest";
import { capturePayload, loadProvider } from "./fixtures.ts";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.ts";

const temp = useOpenAICompatibleProviderTestSetup();

describe("openai-compatible-provider payload", () => {
	it.each(["openai-completions", "openai-responses"] as const)("%s 在原生请求上应用 extraBody 和各层 dropParams", async (api) => {
		const fixture = await loadProvider(temp.path, {
			api, dropParams: ["store"], extraBody: { temperature: 0.8, custom: true },
			models: [{ id: "m", maxTokens: 8192, samplingParams: { temperature: 0.2, top_p: 0.9, top_k: 40 }, dropParams: ["top_p"] }],
			modelOverrides: { m: { dropParams: ["top_p", "top_k"] } },
		});
		const request = await capturePayload(fixture, { samplingParams: { temperature: 0.7 } });
		expect(request).toMatchObject({ model: "m", stream: true, temperature: 0.8, custom: true });
		expect(request).toHaveProperty(api === "openai-responses" ? "max_output_tokens" : "max_completion_tokens", 8192);
		for (const key of ["store", "top_p", "top_k"]) expect(request).not.toHaveProperty(key);
	});

	it("同一 provider 的混合 API 模型均经过扩展并保留图片输入", async () => {
		const fixture = await loadProvider(temp.path, {
			extraBody: { custom: true },
			models: [
				{ id: "chat", api: "openai-completions", input: ["text", "image"] },
				{ id: "responses", api: "openai-responses", input: ["text", "image"] },
			],
		});
		for (const [modelId, field] of [["chat", "messages"], ["responses", "input"]] as const) {
			const request = await capturePayload(fixture, {}, { modelId, context: { messages: [{
				role: "user", timestamp: 0,
				content: [{ type: "text", text: "look" }, { type: "image", data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", mimeType: "image/gif" }],
			}] } });
			expect(request).toMatchObject({ model: modelId, custom: true });
			expect(request).toHaveProperty(field);
			expect(JSON.stringify(request)).toContain("data:image/gif;base64,R0lGODlhAQAB");
		}
	});

	it.each(["openai-completions", "openai-responses"] as const)("%s 的调用方 onPayload 在扩展后运行，可修改或替换请求体", async (api) => {
		const fixture = await loadProvider(temp.path, { api, extraBody: { custom: true }, dropParams: ["store"] });
		const request = await capturePayload(fixture, { onPayload: (payload) => {
			expect(payload).toHaveProperty("custom", true);
			expect(payload).not.toHaveProperty("store");
			return Object.assign({}, payload, { caller: true });
		} });
		expect(request).toMatchObject({ custom: true, caller: true });
		const mutated = await capturePayload(fixture, { onPayload: (payload) => {
			Object.assign(payload ?? {}, { mutated: true });
		} });
		expect(mutated).toHaveProperty("mutated", true);
	});
});

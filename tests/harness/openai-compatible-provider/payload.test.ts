import { createModels } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { capturePayload, loadProvider } from "./fixtures.ts";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.ts";

const temp = useOpenAICompatibleProviderTestSetup();

describe("openai-compatible-provider payload", () => {
	it.each(["openai-completions", "openai-responses"] as const)("%s 保留采样覆盖顺序、输出上限和 payload 扩展", async (api) => {
		const provider = await loadProvider(temp.path, {
			api, dropParams: ["store"], extraBody: { temperature: 0.8, custom: true },
			models: [{ id: "m", maxTokens: 8192, samplingParams: { temperature: 0.2, top_p: 0.9, top_k: 40 }, dropParams: ["top_p"] }],
		});
		const request = await capturePayload(provider, { samplingParams: { temperature: 0.7, top_k: 20 } }, { simple: true });
		expect(request).toMatchObject({ model: "m", stream: true, temperature: 0.8, top_k: 20, custom: true });
		expect(request).toHaveProperty(api === "openai-responses" ? "max_output_tokens" : "max_completion_tokens", 8192);
		expect(request).not.toHaveProperty("store");
		expect(request).not.toHaveProperty("top_p");
	});

	it("原生 stream 和 streamSimple 共用请求配置，但分别读取 reasoningEffort 和 reasoning", async () => {
		const provider = await loadProvider(temp.path, {
			api: "openai-responses", thinkingPreset: "deepseek", maxRetries: 0, dropParams: ["store"], extraBody: { custom: true },
			models: [{ id: "m", defaultThinkingLevel: "high", maxTokens: 8192, samplingParams: { temperature: 0.2, top_k: 40 } }],
		});
		const low = await capturePayload(provider, { reasoningEffort: "high", temperature: 0.3, samplingParams: { top_k: 41 }, onPayload: () => undefined });
		const simple = await capturePayload(provider, { reasoning: "high", samplingParams: { temperature: 0.7 } }, { simple: true });
		for (const request of [low, simple]) {
			expect(request).toMatchObject({ model: "m", thinking: { type: "enabled" }, custom: true });
			expect(request).not.toHaveProperty("reasoning");
			expect(request).not.toHaveProperty("store");
		}
		expect(low).toMatchObject({ temperature: 0.3, top_k: 41 });
		expect(simple).toMatchObject({ temperature: 0.7, top_k: 40, max_output_tokens: 8192 });
	});

	it("streamSimple 限制等级，低层 stream 保留调用方的合法等级", async () => {
		const provider = await loadProvider(temp.path, { thinkingPreset: "model-suffix", models: ["m", "m:high"] });
		expect(await capturePayload(provider, { reasoning: "max" }, { simple: true })).toHaveProperty("model", "m:high");
		expect(await capturePayload(provider, { reasoningEffort: "max" })).toHaveProperty("model", "m");
	});

	it("model-suffix 按当前等级路由，不把 map 的上游字符串用于后缀", async () => {
		const provider = await loadProvider(temp.path, {
			api: "openai-responses", thinkingPreset: "model-suffix",
			models: [{ id: "m", thinkingLevelMap: { max: "legacy-max" } }, "m:off", "m:high", "m:max"],
		});
		const request = await capturePayload(provider, { reasoningEffort: "max" });
		expect(request).toHaveProperty("model", "m:max");
		expect(request).not.toHaveProperty("reasoning");
		expect(request).not.toHaveProperty("include");
		expect(await capturePayload(provider)).toHaveProperty("model", "m:off");
	});

	it("model-suffix 没有 off 变体时使用裸模型，并在扩展字段后清理 thinking", async () => {
		const provider = await loadProvider(temp.path, {
			thinkingPreset: "model-suffix", models: ["m", "m:high"],
			extraBody: { thinking: "unwanted", include: ["reasoning.encrypted_content", "other"] },
		});
		const request = await capturePayload(provider);
		expect(request).toMatchObject({ model: "m", include: ["other"] });
		expect(request).not.toHaveProperty("thinking");
	});

	it.each([
		["openrouter", "high", { reasoning: { effort: "high" } }],
		["deepseek", "high", { thinking: { type: "enabled" } }],
		["together", "off", { reasoning: { enabled: false } }],
		["zai", "high", { thinking: { type: "enabled", clear_thinking: false } }],
		["qwen", "off", { enable_thinking: false }],
		["qwen-chat-template", "high", { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } }],
		["chat-template-enabled", "medium", { chat_template_kwargs: { enable_thinking: true } }],
		["chat-template-enabled", "off", { chat_template_kwargs: { enable_thinking: false } }],
		["chat-template-effort", "high", { chat_template_kwargs: { reasoning_effort: "high" } }],
		["string-thinking", "off", { thinking: "none" }],
	] as const)("Responses 将 %s 预设编码到实际请求", async (thinkingPreset, reasoning, expected) => {
		const provider = await loadProvider(temp.path, {
			api: "openai-responses", thinkingPreset, models: [{ id: "m", defaultThinkingLevel: reasoning }],
		});
		const request = await capturePayload(provider, reasoning === "off" ? {} : { reasoning }, { simple: true });
		expect(request).toMatchObject(expected);
		expect(request).not.toHaveProperty("include");
	});

	it.each([
		["chat-template-effort", {}, { chat_template_kwargs: { reasoning_effort: "max" } }],
		["ant-ling", {}, { reasoning: { effort: "max" } }],
		["deepseek", { supportsReasoningEffort: true }, { thinking: { type: "enabled" }, reasoning_effort: "max" }],
	] as const)("Responses %s 使用原生 thinkingLevelMap", async (thinkingPreset, compat, expected) => {
		const provider = await loadProvider(temp.path, {
			api: "openai-responses", thinkingPreset,
			models: [{ id: "m", defaultThinkingLevel: "xhigh", thinkingLevelMap: { xhigh: "max" }, compat }],
		});
		expect(await capturePayload(provider, { reasoningEffort: "xhigh" })).toMatchObject(expected);
	});

	it("模型预设覆盖 provider，openai 保留原生 reasoning，none 移除它", async () => {
		const provider = await loadProvider(temp.path, {
			api: "openai-responses", thinkingPreset: "openai",
			models: [
				{ id: "inherited", defaultThinkingLevel: "high" },
				{ id: "boolean", thinkingPreset: "chat-template-enabled", defaultThinkingLevel: "high" },
				{ id: "none", thinkingPreset: "none", defaultThinkingLevel: "high" },
			],
		});
		const inherited = await capturePayload(provider, { reasoningEffort: "high" }, { modelId: "inherited" });
		expect(inherited).toMatchObject({ reasoning: { effort: "high" }, include: ["reasoning.encrypted_content"] });
		const overridden = await capturePayload(provider, { reasoningEffort: "high" }, { modelId: "boolean" });
		expect(overridden).toHaveProperty("chat_template_kwargs.enable_thinking", true);
		expect(overridden).not.toHaveProperty("reasoning");
		const disabled = await capturePayload(provider, { reasoningEffort: "high" }, { modelId: "none" });
		expect(disabled).not.toHaveProperty("reasoning");
		expect(disabled).not.toHaveProperty("include");
	});

	it("调用方 onPayload 在扩展后运行，可保留、修改或替换请求体", async () => {
		const provider = await loadProvider(temp.path, { extraBody: { custom: true }, dropParams: ["store"] });
		const request = await capturePayload(provider, { onPayload: (payload) => {
			expect(payload).toHaveProperty("custom", true);
			expect(payload).not.toHaveProperty("store");
			return Object.assign({}, payload, { caller: true });
		} });
		expect(request).toMatchObject({ custom: true, caller: true });
		const mutated = await capturePayload(provider, { onPayload: (payload) => {
			Object.assign(payload ?? {}, { mutated: true });
		} });
		expect(mutated).toHaveProperty("mutated", true);
	});

	it.each(["openai-completions", "openai-responses"] as const)("%s 保留原生图片请求", async (api) => {
		const provider = await loadProvider(temp.path, { api, models: [{ id: "m", input: ["text", "image"] }] });
		const request = await capturePayload(provider, {}, { context: { messages: [{
			role: "user", timestamp: 0,
			content: [{ type: "text", text: "look" }, { type: "image", data: "R0lGODlhAQAB", mimeType: "image/gif" }],
		}] } });
		expect(JSON.stringify(request)).toContain("data:image/gif;base64,R0lGODlhAQAB");
		expect(request).toHaveProperty(api === "openai-responses" ? "input" : "messages");
	});

	it.each([undefined, "provider", "caller", null])("请求头按 provider/model/caller 合并，显式值 %s 不被覆盖", async (caller) => {
		const provider = await loadProvider(temp.path, {
			headers: { "X-Value": "provider", "X-Provider": "present" },
			models: [{ id: "m", headers: { "X-Value": "$MODEL_HEADER" } }],
		});
		const model = provider.getModels()[0];
		if (!model) throw new Error("provider model missing");
		const models = createModels();
		models.setProvider(provider);
		let headers: Headers | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			headers = new Headers(init?.headers);
			return new Response('{"error":"stop"}', { status: 400 });
		});
		for await (const _event of models.stream(model, { messages: [{ role: "user", content: "test", timestamp: 0 }] }, {
			env: { MODEL_HEADER: "model" },
			...(caller !== undefined ? { headers: { "x-VALUE": caller } } : {}),
		})) {}
		expect(headers?.get("X-Value")).toBe(caller === undefined ? "model" : caller);
		expect(headers?.get("X-Provider")).toBe("present");
		expect(headers?.has("Authorization")).toBe(false);
	});
});

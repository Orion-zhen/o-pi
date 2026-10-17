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

	it("model-suffix 使用受模型支持的等级，没有 off 变体时使用裸模型", async () => {
		const fixture = await loadProvider(temp.path, {
			api: "openai-responses", thinkingPreset: "model-suffix",
			models: [{ id: "m", reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null } }],
			extraBody: { reasoning: { effort: "high" }, include: ["reasoning.encrypted_content", "message.output_text.logprobs"] },
		});
		expect(await capturePayload(fixture, { reasoning: "max" })).toHaveProperty("model", "m:high");
		const request = await capturePayload(fixture);
		expect(request).toMatchObject({ model: "m", include: ["message.output_text.logprobs"] });
		expect(request).not.toHaveProperty("reasoning");
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
		["ant-ling", "high", { reasoning: { effort: "high" } }],
	] as const)("Responses 将 %s 预设编码到实际请求", async (thinkingPreset, reasoning, expected) => {
		const fixture = await loadProvider(temp.path, {
			api: "openai-responses", thinkingPreset,
			models: [{ id: "m", reasoning: true, thinkingLevelMap: { high: "high" } }],
		});
		const request = await capturePayload(fixture, reasoning === "off" ? {} : { reasoning });
		expect(request).toMatchObject(expected);
		expect(request).not.toHaveProperty("include");
	});

	it("Responses 预设使用模型的等级映射", async () => {
		const fixture = await loadProvider(temp.path, {
			api: "openai-responses", thinkingPreset: "deepseek",
			models: [{ id: "m", reasoning: true, thinkingLevelMap: { xhigh: "max" }, compat: { supportsReasoningEffort: true } }],
		});
		expect(await capturePayload(fixture, { reasoning: "xhigh" })).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "max" });
	});

	it("模型预设与 modelOverrides 覆盖 provider，未覆盖时保留原生 reasoning", async () => {
		const fixture = await loadProvider(temp.path, {
			api: "openai-responses", thinkingPreset: "openai",
			models: [
				{ id: "inherited", reasoning: true },
				{ id: "boolean", thinkingPreset: "chat-template-enabled", reasoning: true },
				{ id: "none", thinkingPreset: "chat-template-enabled", reasoning: true },
			],
			modelOverrides: { none: { thinkingPreset: "none" } },
		});
		const inherited = await capturePayload(fixture, { reasoning: "high" }, { modelId: "inherited" });
		expect(inherited).toMatchObject({ reasoning: { effort: "high" }, include: ["reasoning.encrypted_content"] });
		const overridden = await capturePayload(fixture, { reasoning: "high" }, { modelId: "boolean" });
		expect(overridden).toHaveProperty("chat_template_kwargs.enable_thinking", true);
		expect(overridden).not.toHaveProperty("reasoning");
		const disabled = await capturePayload(fixture, { reasoning: "high" }, { modelId: "none" });
		expect(disabled).not.toHaveProperty("reasoning");
		expect(disabled).not.toHaveProperty("chat_template_kwargs");
		expect(disabled).not.toHaveProperty("include");
	});

	it("调用方 onPayload 在扩展后运行，可修改或替换请求体", async () => {
		const fixture = await loadProvider(temp.path, { extraBody: { custom: true }, dropParams: ["store"] });
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

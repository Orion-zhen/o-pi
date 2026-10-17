import { describe, expect, it } from "vitest";
import { capturePayload, loadProvider } from "./fixtures.ts";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.ts";

const temp = useOpenAICompatibleProviderTestSetup();

describe("统一思考传递方式", () => {
	it.each([
		["openai", { reasoning_effort: "custom" }],
		["openrouter", { reasoning: { effort: "custom" } }],
		["deepseek", { thinking: { type: "enabled" }, reasoning_effort: "custom" }],
		["together", { reasoning: { enabled: true }, reasoning_effort: "custom" }],
		["zai", { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "custom" }],
		["qwen", { enable_thinking: true }],
		["qwen-chat-template", { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } }],
		["chat-template-enabled", { chat_template_kwargs: { enable_thinking: true } }],
		["chat-template-effort", { chat_template_kwargs: { reasoning_effort: "custom" } }],
		["string-thinking", { thinking: "custom" }],
		["ant-ling", { reasoning: { effort: "custom" } }],
	] as const)("Chat Completions 将 %s 交给 SDK 编码并保留等级映射", async (thinkingPreset, expected) => {
		const fixture = await loadProvider(temp.path, {
			thinkingPreset, models: [{ id: "m", reasoning: true, thinkingLevelMap: { high: "custom" } }],
		});
		expect(await capturePayload(fixture, { reasoning: "high" })).toMatchObject(expected);
		expect(fixture.provider.getModels()[0]).not.toHaveProperty("compat.thinkingFormat");
	});

	it.each([
		["chat-template", "chatTemplateKwargs", "chat_template_kwargs"],
		["baseten", "chatTemplateArgs", "chat_template_args"],
	] as const)("%s 保留 SDK 自定义模板与嵌套继承", async (thinkingPreset, option, field) => {
		const fixture = await loadProvider(temp.path, {
			thinkingPreset, compat: { [option]: { custom: "kept", enabled: { $var: "thinking.enabled" } } },
			models: [{ id: "m", reasoning: true, compat: { [option]: { effort: { $var: "thinking.effort" } } } }],
		});
		expect(await capturePayload(fixture, { reasoning: "high" })).toHaveProperty(field, { custom: "kept", enabled: true, effort: "high" });
	});

	it.each(["openai-completions", "openai-responses"] as const)("%s 使用同一套服务、模型和覆盖优先级，auto 恢复 SDK 行为", async (api) => {
		const fixture = await loadProvider(temp.path, {
			api, thinkingPreset: "qwen",
			models: [
				{ id: "inherited", reasoning: true },
				{ id: "defined", reasoning: true, thinkingPreset: "chat-template-enabled" },
				{ id: "overridden", reasoning: true, thinkingPreset: "chat-template-enabled" },
			],
			modelOverrides: { overridden: { thinkingPreset: "auto" } },
		});
		expect(await capturePayload(fixture, { reasoning: "high" }, { modelId: "inherited" })).toHaveProperty("enable_thinking", true);
		expect(await capturePayload(fixture, { reasoning: "high" }, { modelId: "defined" })).toHaveProperty("chat_template_kwargs.enable_thinking", true);
		const automatic = await capturePayload(fixture, { reasoning: "high" }, { modelId: "overridden" });
		expect(automatic).toHaveProperty(api === "openai-completions" ? "reasoning_effort" : "reasoning.effort", "high");
		expect(automatic).not.toHaveProperty("chat_template_kwargs");
		expect(automatic).not.toHaveProperty("enable_thinking");
	});

	it.each([undefined, "auto"] as const)("%s 保留 SDK 的地址检测，显式预设可覆盖检测结果", async (thinkingPreset) => {
		const fixture = await loadProvider(temp.path, {
			thinkingPreset, baseUrl: "https://api.deepseek.com/v1", models: [{ id: "m", reasoning: true }],
		});
		expect(await capturePayload(fixture, { reasoning: "high" })).toHaveProperty("thinking.type", "enabled");
		const explicit = await loadProvider(temp.path, {
			thinkingPreset: "openai", baseUrl: "https://api.deepseek.com/v1", models: [{ id: "m", reasoning: true }],
		});
		const request = await capturePayload(explicit, { reasoning: "high" });
		expect(request).toHaveProperty("reasoning_effort", "high");
		expect(request).not.toHaveProperty("thinking");
	});

	it.each(["openai-completions", "openai-responses"] as const)("%s 的 none 清除思考控制参数，但不禁用模型能力", async (api) => {
		const fixture = await loadProvider(temp.path, {
			api, thinkingPreset: "none", models: [{ id: "m", reasoning: true }],
			extraBody: {
				reasoning: { effort: "high" }, thinking: { type: "enabled" }, enable_thinking: true,
				chat_template_kwargs: { enable_thinking: true }, chat_template_args: { enabled: true },
				thinking_token_budget: 1024, thinking_budget: 1024, thinking_budget_tokens: 1024,
				include: ["reasoning.encrypted_content", "message.output_text.logprobs"],
			},
		});
		for (const reasoning of ["off", "high"] as const) {
			const request = await capturePayload(fixture, reasoning === "off" ? {} : { reasoning });
			expect(request).toMatchObject({ model: "m", include: ["message.output_text.logprobs"] });
			for (const key of ["reasoning", "reasoning_effort", "thinking", "enable_thinking", "chat_template_kwargs", "chat_template_args",
				"thinking_token_budget", "thinking_budget", "thinking_budget_tokens"]) expect(request).not.toHaveProperty(key);
		}
		expect(fixture.provider.getModels()[0]?.reasoning).toBe(true);
	});

	it.each(["chat-template-enabled", "chat-template-effort"] as const)("Chat Completions 的 %s 支持 off", async (thinkingPreset) => {
		const fixture = await loadProvider(temp.path, { thinkingPreset, models: [{ id: "m", reasoning: true }] });
		const request = await capturePayload(fixture);
		if (thinkingPreset === "chat-template-enabled") expect(request).toHaveProperty("chat_template_kwargs", { enable_thinking: false });
		else expect(request).not.toHaveProperty("chat_template_kwargs");
	});

	it.each(["baseten", "chat-template"] as const)("下层拒绝 Responses 使用 %s，包括混合 API 模型", async (thinkingPreset) => {
		await expect(loadProvider(temp.path, { api: "openai-responses", thinkingPreset })).rejects.toThrow("requires openai-completions");
		await expect(loadProvider(temp.path, { thinkingPreset, models: [{ id: "m", api: "openai-responses" }] }))
			.rejects.toThrow("requires openai-completions");
		await expect(loadProvider(temp.path, {
			thinkingPreset, models: [{ id: "m", api: "openai-responses" }], modelOverrides: { m: { thinkingPreset: "auto" } },
		})).resolves.toBeDefined();
	});
});

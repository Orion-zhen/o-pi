import { describe, expect, it } from "vitest";

import { loadProvider } from "./fixtures.js";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.js";

const temp = useOpenAICompatibleProviderTestSetup();

const invalidConfigs = [
	["provider defaults", { apiKey: "sk-secret", defaults: {} }, "providers.vllm.defaults is not supported"],
	["provider sampling", { apiKey: "sk-secret", temperature: 0.2 }, "providers.vllm.temperature is not supported"],
	["provider core dropParams", { dropParams: ["model"] }, 'providers.vllm.dropParams cannot remove core request field "model"'],
	["model core dropParams", { models: [{ id: "m", dropParams: ["messages"] }] }, 'providers.vllm.models[0].dropParams cannot remove core request field "messages"'],
	["provider core extraBody", { extraBody: { tools: [] } }, 'providers.vllm.extraBody.tools cannot override core request field "tools"'],
	["duplicate model", { models: ["qwen3-coder", { id: "qwen3-coder" }] }, 'provider "vllm" contains duplicate model "qwen3-coder"'],
	["removed model extraBody", { models: [{ id: "m", extraBody: { custom: true } }] }, undefined],
	["removed model defaults", { models: [{ id: "m", defaults: { topP: 0.9 } }] }, undefined],
	["legacy provider fields", { base_url: "http://127.0.0.1:8000/v1", api_key: "EMPTY" }, undefined],
	["missing model id", { models: [{}] }, undefined],
	["missing baseUrl", { baseUrl: undefined }, "providers.vllm.baseUrl is required"],
	["removed compatPreset", { compatPreset: "foo" }, "providers.vllm.compatPreset is not supported"],
	["legacy reasoning effort", { models: [{ id: "m", reasoning_effort: "high" }] }, undefined],
	["unknown provider thinking preset", { thinkingPreset: "unknown" }, "providers.vllm.thinkingPreset must be equal to one of the allowed values"],
	["unknown model thinking preset", { models: [{ id: "m", thinkingPreset: "unknown" }] }, undefined],
	["unknown default thinking level", { models: [{ id: "m", defaultThinkingLevel: "turbo" }] }, undefined],
	["unsupported default thinking level", { models: [{ id: "m", defaultThinkingLevel: "max" }] }, 'defaultThinkingLevel "max" is not supported'],
	["unknown thinking map key", { models: [{ id: "m", thinkingLevelMap: { turbo: "turbo" } }] }, undefined],
	["default excluded by thinking map", { models: [{ id: "m", defaultThinkingLevel: "high", thinkingLevelMap: { high: null } }] }, 'defaultThinkingLevel "high" is not supported'],
	["reasoning conflicts with default", { models: [{ id: "m", reasoning: false, defaultThinkingLevel: "off" }] }, "reasoning=false conflicts"],
	["reasoning conflicts with map", { models: [{ id: "m", reasoning: false, thinkingLevelMap: { high: "high" } }] }, "reasoning=false conflicts"],
] as const;

describe("openai-compatible-provider normalization", () => {
	it("采用 Pi 原生 provider/model 字段，并允许模型级覆盖", async () => {
		const provider = await loadProvider(temp.path, {
			api: "openai-completions",
			compat: { supportsStore: true },
			models: [{
				id: "m", name: "Native Model", api: "openai-responses", baseUrl: "https://responses.test/v1",
				reasoning: true, contextWindow: 200000, maxTokens: 8192,
				headers: { "X-Model": "$MODEL_HEADER" },
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
				compat: { supportsDeveloperRole: true, supportsToolSearch: true },
			}],
		}, "mixed");
		expect(provider.getModels()[0]).toMatchObject({
			id: "m", name: "Native Model", api: "openai-responses", baseUrl: "https://responses.test/v1",
			reasoning: true, contextWindow: 200000, maxTokens: 8192,
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
			compat: { supportsStore: true, supportsDeveloperRole: true, supportsToolSearch: true },
		});
		expect(provider.getModels()[0]).not.toHaveProperty("headers");
	});

	it("provider/model compat 按顶层覆盖且对象字段整体替换", async () => {
		const provider = await loadProvider(temp.path, {
			thinkingPreset: "chat-template-enabled",
			compat: { supportsToolSearch: true, openRouterRouting: { order: ["one"] }, chatTemplateKwargs: { provider: true } },
			models: [{ id: "m", compat: { openRouterRouting: { allow_fallbacks: false }, chatTemplateKwargs: { model: true } } }],
		});
		expect(provider.getModels()[0]?.compat).toMatchObject({
			supportsToolSearch: true, openRouterRouting: { allow_fallbacks: false }, chatTemplateKwargs: { model: true },
		});
		expect(provider.getModels()[0]?.compat).not.toHaveProperty("openRouterRouting.order");
		expect(provider.getModels()[0]?.compat).not.toHaveProperty("chatTemplateKwargs.provider");
	});

	it("保守 compat 默认值可由 provider 和 model 原生 compat 覆盖", async () => {
		const provider = await loadProvider(temp.path, {
			compat: { supportsDeveloperRole: true, maxTokensField: "max_tokens" },
			models: [{ id: "m", compat: { supportsStore: true } }],
		});
		expect(provider.getModels()[0]?.compat).toMatchObject({
			supportsStore: true, supportsDeveloperRole: true, supportsReasoningEffort: false, maxTokensField: "max_tokens",
		});
	});

	it("model-suffix 折叠同一基础模型的已知 thinking 变体", async () => {
		const provider = await loadProvider(temp.path, {
			thinkingPreset: "model-suffix",
			models: [
				{ id: "m", name: "Reasoning Model" }, "m:off", "m:high", "m:max", "literal:extended", "standalone:high",
			],
		});
		expect(provider.getModels().map((model) => model.id)).toEqual(["m", "literal:extended", "standalone:high"]);
		expect(provider.getModels()[0]).toMatchObject({
			name: "Reasoning Model", reasoning: true,
			thinkingLevelMap: { off: "off", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
		});
	});

	it("model-suffix 保留手写模型声明的等级可用性和映射", async () => {
		const provider = await loadProvider(temp.path, {
			thinkingPreset: "model-suffix",
			models: [{ id: "m", defaultThinkingLevel: "max", thinkingLevelMap: { off: "disabled", high: "legacy-high", max: "legacy-max" } }, "m:high"],
		});
		expect(provider.getModels()[0]).toMatchObject({
			reasoning: true, thinkingLevelMap: { off: "disabled", high: "legacy-high", max: "legacy-max" },
		});
	});

	it("未启用 model-suffix 时保留完整的冒号模型 ID", async () => {
		const provider = await loadProvider(temp.path, { models: ["m", "m:off", "m:high"] });
		expect(provider.getModels().map((model) => model.id)).toEqual(["m", "m:off", "m:high"]);
	});

	it("chat-template-enabled 使用 Pi 原生布尔变量", async () => {
		const provider = await loadProvider(temp.path, {
			thinkingPreset: "chat-template-enabled", models: [{ id: "m", defaultThinkingLevel: "high" }],
		});
		expect(provider.getModels()[0]).toMatchObject({
			reasoning: true,
			compat: { thinkingFormat: "chat-template", chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } } },
		});
		expect(provider.getModels()[0]?.thinkingLevelMap).toBeUndefined();
	});

	it("reasoning/defaultThinkingLevel/map 推导模型能力并保留 off 和 max", async () => {
		const provider = await loadProvider(temp.path, {
			models: [
				{ id: "native", reasoning: true },
				{ id: "reasoning", defaultThinkingLevel: "high" },
				{ id: "off", defaultThinkingLevel: "off" },
				{ id: "mapped", thinkingLevelMap: { max: "max" } },
				"plain",
			],
		});
		expect(provider.getModels().map((model) => [model.id, model.reasoning])).toEqual([
			["native", true], ["reasoning", true], ["off", true], ["mapped", true], ["plain", false],
		]);
		expect(provider.getModels().find((model) => model.id === "mapped")?.thinkingLevelMap).toEqual({ max: "max" });
	});

	it("samplingParams 和未来 compat 字段原样进入 Pi 原生 Model", async () => {
		const provider = await loadProvider(temp.path, {
			compat: { supportsFinishReason: false, supportsThinkingTokenBudget: true, futureCompatOption: { provider: true } },
			models: [{
				id: "m", samplingParams: { top_k: 40, min_p: 0.1, repetition_penalty: 1.05 },
				compat: { supportsExplicitPromptCacheMode: true, futureCompatOption: { model: true } },
			}],
		});
		expect(provider.getModels()[0]).toMatchObject({
			samplingParams: { top_k: 40, min_p: 0.1, repetition_penalty: 1.05 },
			compat: { supportsFinishReason: false, supportsThinkingTokenBudget: true, supportsExplicitPromptCacheMode: true, futureCompatOption: { model: true } },
		});
	});

	it.each(invalidConfigs)("拒绝 %s 且不泄露密钥", async (_name, overrides, expected) => {
		const result = loadProvider(temp.path, overrides, "vllm");
		await expect(result).rejects.toThrow(expected);
		await expect(result).rejects.not.toThrow("sk-secret");
	});
});

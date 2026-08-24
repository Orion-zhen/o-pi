import { describe, expect, it } from "vitest";

import { applyRuntimePayloadConfig } from "../../src/openai-compatible-provider/normalize.js";
import { normalizeProvider, normalizeRuntime } from "./fixtures.js";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.js";

const temp = useOpenAICompatibleProviderTestSetup();

const invalidConfigs = [
	["provider defaults", { apiKey: "sk-secret", defaults: {} }, "providers.vllm.defaults is not supported", "sk-secret"],
	["provider sampling", { apiKey: "sk-secret", temperature: 0.2 }, "providers.vllm.temperature is not supported", "sk-secret"],
	["provider core dropParams", { dropParams: ["model"] }, "providers.vllm.dropParams cannot remove core request field \"model\"", undefined],
	["model core dropParams", { models: [{ id: "m", dropParams: ["messages"] }] }, "providers.vllm.models[0].dropParams cannot remove core request field \"messages\"", undefined],
	["duplicate model", { models: ["qwen3-coder", { id: "qwen3-coder" }] }, 'provider "vllm" contains duplicate model "qwen3-coder"', undefined],
	["removed model extraBody", { models: [{ id: "m", extraBody: { custom: true } }] }, undefined, undefined],
	["removed model defaults", { models: [{ id: "m", defaults: { topP: 0.9 } }] }, undefined, undefined],
	["legacy provider fields", {
		base_url: "http://127.0.0.1:8000/v1",
		api_key: "EMPTY",
	}, undefined, undefined],
	["missing model id", { models: [{}] }, undefined, undefined],
	["missing baseUrl", { baseUrl: undefined }, "providers.vllm.baseUrl is required", undefined],
	["removed compatPreset", { compatPreset: "foo" }, "providers.vllm.compatPreset is not supported", undefined],
	["legacy reasoning effort", { models: [{ id: "m", reasoning_effort: "high" }] }, undefined, undefined],
	["unknown provider thinking preset", { thinkingPreset: "unknown" }, "providers.vllm.thinkingPreset must be equal to one of the allowed values", undefined],
	["unknown model thinking preset", { models: [{ id: "m", thinkingPreset: "unknown" }] }, undefined, undefined],
	["unsupported default thinking level", { models: [{ id: "m", defaultThinkingLevel: "max" }] }, 'defaultThinkingLevel "max" is not supported', undefined],
	["unknown thinking map key", { models: [{ id: "m", thinkingLevelMap: { turbo: "turbo" } }] }, 'thinkingLevelMap contains unknown Pi thinking level "turbo"', undefined],
	["default excluded by thinking map", {
		models: [{ id: "m", defaultThinkingLevel: "high", thinkingLevelMap: { high: null } }],
	}, 'defaultThinkingLevel "high" is not supported', undefined],
] as const;

describe("openai-compatible-provider normalization", () => {
	it("对象 model id 同时作为 Pi 与 API model 名", async () => {
		const { provider, runtime } = await normalizeRuntime(temp.path, {
			baseUrl: "https://openrouter.ai/api/v1",
			apiKey: "$OPENROUTER_API_KEY",
			models: [{ id: "deepseek/deepseek-r1", name: "DeepSeek R1" }],
		}, "openrouter", "deepseek/deepseek-r1");
		expect(provider.models[0]).toMatchObject({ id: "deepseek/deepseek-r1", name: "DeepSeek R1" });
		expect(applyRuntimePayloadConfig({ model: "deepseek/deepseek-r1", messages: [], stream: true }, runtime))
			.toMatchObject({ model: "deepseek/deepseek-r1" });
	});

	it("采用 Pi 原生 provider/model 字段，并允许模型级覆盖", async () => {
		const provider = await normalizeProvider(temp.path, {
			api: "openai-completions",
			compat: { supportsStore: true },
			models: [{
				id: "m",
				name: "Native Model",
				api: "openai-responses",
				baseUrl: "https://responses.test/v1",
				reasoning: true,
				contextWindow: 200000,
				maxTokens: 8192,
				headers: { "X-Model": "$MODEL_HEADER" },
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
				compat: { supportsDeveloperRole: true, supportsToolSearch: true },
			}],
		}, "mixed");
		const model = provider.models[0];
		expect(model).toMatchObject({
			id: "m",
			name: "Native Model",
			api: "openai-responses",
			baseUrl: "https://responses.test/v1",
			reasoning: true,
			contextWindow: 200000,
			maxTokens: 8192,
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
			compat: { supportsDeveloperRole: true, supportsToolSearch: true },
		});
		expect(model?.compat).toMatchObject({ supportsStore: true });
		expect(provider.runtimeModels.get("m")?.compat).toMatchObject({ supportsStore: true });
		expect(provider.runtimeModels.get("m")?.headers).toEqual({ "X-Model": "$MODEL_HEADER" });
	});

	it("provider/model compat 按顶层覆盖且对象字段整体替换", async () => {
		const provider = await normalizeProvider(temp.path, {
			thinkingPreset: "chat-template-enabled",
			compat: {
				supportsToolSearch: true,
				openRouterRouting: { order: ["one"] },
				chatTemplateKwargs: { provider: true },
			},
			models: [{
				id: "m",
				compat: {
					openRouterRouting: { allow_fallbacks: false },
					chatTemplateKwargs: { model: true },
				},
			}],
		}, "router");
		const compat = provider.runtimeModels.get("m")?.compat;
		expect(compat?.openRouterRouting).toEqual({ allow_fallbacks: false });
		expect(compat?.chatTemplateKwargs).toEqual({ model: true });
		expect(compat).toMatchObject({ supportsToolSearch: true });
	});

	it("保守 compat 默认值可由 provider 和 model 原生 compat 覆盖", async () => {
		const provider = await normalizeProvider(temp.path, {
			compat: { supportsDeveloperRole: true, maxTokensField: "max_tokens" },
			models: [{ id: "m", compat: { supportsStore: true } }],
		}, "vllm");
		expect(provider.models[0]?.compat).toMatchObject({
			supportsStore: true,
			supportsDeveloperRole: true,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		});
	});

	it("model-suffix 折叠同一基础模型的已知 thinking 变体", async () => {
		const provider = await normalizeProvider(temp.path, {
			thinkingPreset: "model-suffix",
			models: [
				{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
				"deepseek-v4-flash:off",
				"deepseek-v4-flash:high",
				"deepseek-v4-flash:max",
				"literal:extended",
				"standalone:high",
			],
		}, "llama-swap");

		expect(provider.models.map((model) => model.id)).toEqual([
			"deepseek-v4-flash",
			"literal:extended",
			"standalone:high",
		]);
		expect(provider.models[0]).toMatchObject({
			name: "DeepSeek V4 Flash",
			reasoning: true,
			thinkingLevelMap: {
				off: "off",
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: null,
				max: "max",
			},
		});
		expect(provider.runtimeModels.get("deepseek-v4-flash")).toMatchObject({
			thinkingPreset: "model-suffix",
			reasoning: true,
		});
	});

	it("model-suffix 保留手写模型声明的等级可用性", async () => {
		const provider = await normalizeProvider(temp.path, {
			thinkingPreset: "model-suffix",
			models: [{
				id: "reasoning-model",
				defaultThinkingLevel: "max",
				thinkingLevelMap: { off: "disabled", high: "legacy-high", max: "legacy-max" },
			}],
		});
		expect(provider.models[0]).toMatchObject({
			reasoning: true,
			thinkingLevelMap: { off: "disabled", high: "legacy-high", max: "legacy-max" },
		});
		expect(provider.runtimeModels.get("reasoning-model")?.defaultThinkingLevel).toBe("max");
	});

	it("未启用 model-suffix 时保留完整的冒号模型 ID", async () => {
		const provider = await normalizeProvider(temp.path, {
			models: ["model", "model:off", "model:high"],
		});
		expect(provider.models.map((model) => model.id)).toEqual(["model", "model:off", "model:high"]);
	});

	it("chat-template-enabled 将非 off 等级映射为 Pi 布尔变量", async () => {
		const provider = await normalizeProvider(temp.path, {
			api: "openai-completions",
			thinkingPreset: "chat-template-enabled",
			models: [{ id: "m", defaultThinkingLevel: "high" }],
		}, "local");
		expect(provider.models[0]).toMatchObject({
			reasoning: true,
			compat: {
				thinkingFormat: "chat-template",
				chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
			},
		});
		expect(provider.models[0]?.thinkingLevelMap).toBeUndefined();
	});

	it("模型 thinking 覆盖 provider preset，未配置模型继续继承", async () => {
		const provider = await normalizeProvider(temp.path, {
			api: "openai-responses",
			thinkingPreset: "openai",
			models: [
				{ id: "inherited", defaultThinkingLevel: "high" },
				{ id: "boolean", thinkingPreset: "chat-template-enabled", defaultThinkingLevel: "high" },
			],
		}, "mixed");
		const inherited = provider.runtimeModels.get("inherited");
		const overridden = provider.runtimeModels.get("boolean");
		if (!inherited || !overridden) throw new Error("runtime config missing");
		expect(inherited).toMatchObject({
			thinkingPreset: "openai",
			compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
		});
		expect(overridden).toMatchObject({
			thinkingPreset: "chat-template-enabled",
			compat: {
				supportsReasoningEffort: false,
				thinkingFormat: "chat-template",
				chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
			},
		});
		expect(applyRuntimePayloadConfig(
			{ model: "inherited", input: [], reasoning: { effort: "high" } },
			inherited,
			"high",
		)).toMatchObject({ reasoning: { effort: "high" } });
		expect(applyRuntimePayloadConfig(
			{ model: "boolean", input: [], reasoning: { effort: "high" } },
			overridden,
			"high",
		)).toMatchObject({ chat_template_kwargs: { enable_thinking: true } });
	});

	it("reasoning/defaultThinkingLevel 保留 off 模型切换能力", async () => {
		const provider = await normalizeProvider(temp.path, {
			thinkingPreset: "openai",
			models: [
				{ id: "reasoning-model", defaultThinkingLevel: "high" },
				{ id: "off-model", defaultThinkingLevel: "off" },
				{ id: "plain-model" },
			],
		});
		expect(provider.models).toMatchObject([
			{ id: "reasoning-model", reasoning: true },
			{ id: "off-model", reasoning: true },
			{ id: "plain-model", reasoning: false },
		]);
		expect(provider.runtimeModels.get("reasoning-model")).toMatchObject({
			defaultThinkingLevel: "high",
			compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
		});
		expect(provider.runtimeModels.get("off-model")?.defaultThinkingLevel).toBe("off");
	});

	it("samplingParams 原样进入 Pi 原生 Model，不再经过运行时 payload 转换", async () => {
		const { provider, runtime } = await normalizeRuntime(temp.path, {
			models: [{ id: "m", samplingParams: { top_k: 40, min_p: 0.1, repetition_penalty: 1.05 } }],
		});
		expect(provider.models[0]?.samplingParams).toEqual({ top_k: 40, min_p: 0.1, repetition_penalty: 1.05 });
		expect(applyRuntimePayloadConfig({ model: "m", messages: [], stream: true }, runtime)).toEqual({
			model: "m",
			messages: [],
			stream: true,
		});
	});

	it("compat 原样透传 Pi 当前字段和未来未知字段", async () => {
		const provider = await normalizeProvider(temp.path, {
			compat: {
				supportsFinishReason: false,
				supportsThinkingTokenBudget: true,
				futureCompatOption: { provider: true },
			},
			models: [{
				id: "m",
				compat: {
					supportsExplicitPromptCacheMode: true,
					futureCompatOption: { model: true },
				},
			}],
		}, "future");
		expect(provider.models[0]?.compat).toMatchObject({
			supportsFinishReason: false,
			supportsThinkingTokenBudget: true,
			supportsExplicitPromptCacheMode: true,
			futureCompatOption: { model: true },
		});
	});

	it("保留原生 reasoning 和 max thinking map", async () => {
		const provider = await normalizeProvider(temp.path, {
			models: [
				{ id: "native", reasoning: true },
				{ id: "mapped", thinkingLevelMap: { max: "max" } },
			],
		}, "vllm");
		expect(provider.models.find((model) => model.id === "native")?.reasoning).toBe(true);
		expect(provider.models.find((model) => model.id === "mapped")).toMatchObject({
			reasoning: true,
			thinkingLevelMap: { max: "max" },
		});
	});

	it.each(invalidConfigs)("拒绝 %s", async (_name, overrides, expected, redacted) => {
		const message = await rejectionMessage(normalizeProvider(temp.path, overrides, "vllm"));
		if (expected) expect(message).toContain(expected);
		if (redacted) expect(message).not.toContain(redacted);
	});
});

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected promise to reject");
}

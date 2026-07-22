import { describe, expect, it } from "vitest";

import { applyRuntimePayloadConfig } from "../../src/openai-compatible-provider/index.js";
import { normalizeFromText } from "./fixtures.js";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.js";

const temp = useOpenAICompatibleProviderTestSetup();

describe("openai-compatible-provider normalization", () => {
	it("对象模型的 model 同时作为 Pi model id 和 API model 名", async () => {
		const [provider] = await normalizeFromText(temp.path, `{
			"providers": {
				"openrouter": {
					"baseUrl": "https://openrouter.ai/api/v1",
					"apiKey": "$OPENROUTER_API_KEY",
					"models": [{ "id": "deepseek/deepseek-r1", "name": "DeepSeek R1" }]
				}
			}
		}`);
		const model = provider?.models?.[0];
		expect(model?.id).toBe("deepseek/deepseek-r1");
		expect(model?.name).toBe("DeepSeek R1");
		const runtime = provider?.runtimeModels.get("deepseek/deepseek-r1");
		if (!runtime) throw new Error("runtime config missing");
		expect(applyRuntimePayloadConfig({ model: model?.id, messages: [], stream: true }, runtime)).toMatchObject({
			model: "deepseek/deepseek-r1",
		});
	});

	it("直接采用 Pi 原生 api/model 字段，并允许模型级覆盖", async () => {
		const [provider] = await normalizeFromText(temp.path, `{
			"providers": {
				"mixed": {
					"baseUrl": "https://example.test/v1",
					"apiKey": "EMPTY",
					"api": "openai-completions",
					"compat": { "supportsStore": true },
					"models": [{
						"id": "m",
						"name": "Native Model",
						"api": "openai-responses",
						"baseUrl": "https://responses.test/v1",
						"reasoning": true,
						"contextWindow": 200000,
						"maxTokens": 8192,
						"headers": { "X-Model": "$MODEL_HEADER" },
						"cost": { "input": 1, "output": 2, "cacheRead": 0.1, "cacheWrite": 0.2 },
						"compat": { "supportsDeveloperRole": true, "supportsToolSearch": true }
					}]
				}
			}
		}`);
		const model = provider?.models[0];
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
		expect(model?.compat).not.toHaveProperty("supportsStore");
		expect(provider?.runtimeModels.get("m")?.compat).toMatchObject({ supportsStore: true });
		expect(provider?.runtimeModels.get("m")?.headers).toEqual({ "X-Model": "$MODEL_HEADER" });
	});

	it("nested compat 按 Pi 原生语义合并", async () => {
		const [provider] = await normalizeFromText(temp.path, `{
			"providers": {
				"router": {
					"baseUrl": "https://router.test/v1",
					"apiKey": "EMPTY",
					"compat": {
						"supportsToolSearch": true,
						"openRouterRouting": { "order": ["one"] },
						"chatTemplateKwargs": { "provider": true }
					},
					"models": [{
						"id": "m",
						"compat": {
							"openRouterRouting": { "allow_fallbacks": false },
							"chatTemplateKwargs": { "model": true }
						}
					}]
				}
			}
		}`);
		expect(provider?.models[0]?.compat).toMatchObject({
			openRouterRouting: { order: ["one"], allow_fallbacks: false },
			chatTemplateKwargs: { provider: true, model: true },
		});
		expect(provider?.models[0]?.compat).not.toHaveProperty("supportsToolSearch");
	});

	it("compat local 展开为当前 Pi 支持的 compat 字段", async () => {
		const [provider] = await normalizeFromText(temp.path, `{
			"providers": {
				"vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "compatPreset": "local", "models": ["m"] }
			}
		}`);
		expect(provider?.models?.[0]?.compat).toMatchObject({
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			maxTokensField: "max_tokens",
		});
	});

	it("Chat chat-template-enabled 不需要 map，并把所有非 off 等级交给 Pi 的布尔变量", async () => {
		const [provider] = await normalizeFromText(temp.path, `{
			"providers": {
				"local": {
					"baseUrl": "http://127.0.0.1:8000/v1",
					"apiKey": "EMPTY",
					"api": "openai-completions",
					"compatPreset": "local",
					"thinkingPreset": "chat-template-enabled",
					"models": [{ "id": "m", "defaultThinkingLevel": "high" }]
				}
			}
		}`);
		expect(provider?.models?.[0]).toMatchObject({
			reasoning: true,
			compat: {
				thinkingFormat: "chat-template",
				chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
			},
		});
		expect(provider?.models?.[0]?.thinkingLevelMap).toBeUndefined();
	});

	it("模型级 thinking 覆盖 provider preset，未配置的模型继续继承 provider", async () => {
		const [provider] = await normalizeFromText(temp.path, `{
			"providers": {
				"mixed": {
					"baseUrl": "http://127.0.0.1:8000/v1",
					"apiKey": "EMPTY",
					"api": "openai-responses",
					"thinkingPreset": "openai",
					"models": [
						{ "id": "inherited", "defaultThinkingLevel": "high" },
						{ "id": "boolean", "thinkingPreset": "chat-template-enabled", "defaultThinkingLevel": "high" }
					]
				}
			}
		}`);
		expect(provider?.runtimeModels.get("inherited")?.thinkingPreset).toBe("openai");
		expect(provider?.runtimeModels.get("boolean")?.thinkingPreset).toBe("chat-template-enabled");
		expect(provider?.runtimeModels.get("inherited")?.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
		});
		expect(provider?.runtimeModels.get("boolean")?.compat).toMatchObject({
			supportsReasoningEffort: false,
			thinkingFormat: "chat-template",
			chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
		});
		const inherited = provider?.runtimeModels.get("inherited");
		const overridden = provider?.runtimeModels.get("boolean");
		if (!inherited || !overridden) throw new Error("runtime config missing");
		expect(applyRuntimePayloadConfig({ model: "inherited", input: [], reasoning: { effort: "high" } }, inherited, "high")).toMatchObject({
			reasoning: { effort: "high" },
		});
		expect(applyRuntimePayloadConfig({ model: "boolean", input: [], reasoning: { effort: "high" } }, overridden, "high")).toMatchObject({
			chat_template_kwargs: { enable_thinking: true },
		});
	});

	it("reasoning/defaultThinkingLevel 使用 Pi 模型能力并保留 off 模型的可切换 reasoning", async () => {
		const [provider] = await normalizeFromText(temp.path, `{
			"providers": {
				"gateway": {
					"baseUrl": "https://example.test/v1",
					"apiKey": "EMPTY",
					"thinkingPreset": "openai",
					"models": [
						{ "id": "reasoning-model", "defaultThinkingLevel": "high" },
						{ "id": "off-model", "defaultThinkingLevel": "off" },
						{ "id": "plain-model" }
					]
				}
			}
		}`);
		expect(provider?.models?.[0]).toMatchObject({ id: "reasoning-model", reasoning: true });
		expect(provider?.models?.[1]).toMatchObject({ id: "off-model", reasoning: true });
		expect(provider?.models?.[2]).toMatchObject({ id: "plain-model", reasoning: false });
		expect(provider?.runtimeModels.get("reasoning-model")?.defaultThinkingLevel).toBe("high");
		expect(provider?.runtimeModels.get("off-model")?.defaultThinkingLevel).toBe("off");
		expect(provider?.models?.[0]?.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
		});
	});

	it("拒绝 provider 级 defaults 和采样字段，且错误不泄露 apiKey", async () => {
		await expect(
			normalizeFromText(temp.path, `{
				"providers": {
					"vllm": {
						"baseUrl": "http://127.0.0.1:8000/v1",
						"apiKey": "sk-secret",
						"defaults": {},
						"models": ["m"]
					}
				}
			}`),
		).rejects.toThrow("providers.vllm.defaults is not supported");

		await expect(
			normalizeFromText(temp.path, `{
				"providers": {
					"vllm": {
						"baseUrl": "http://127.0.0.1:8000/v1",
						"apiKey": "sk-secret",
						"temperature": 0.2,
						"models": ["m"]
					}
				}
			}`),
		).rejects.not.toThrow("sk-secret");
	});

	it("重复 model 报错", async () => {
		await expect(
			normalizeFromText(temp.path, `{
				"providers": {
					"vllm": {
						"baseUrl": "http://127.0.0.1:8000/v1",
						"apiKey": "EMPTY",
						"models": ["qwen3-coder", { "id": "qwen3-coder" }]
					}
				}
			}`),
		).rejects.toThrow('provider "vllm" contains duplicate model "qwen3-coder"');
	});

	it("不兼容的非标准 defaults 会报错而不是静默丢弃", async () => {
		await expect(normalizeFromText(temp.path, `{
			"providers": {
				"gateway": {
					"baseUrl": "https://gateway.example.com/v1",
					"apiKey": "EMPTY",
					"compatPreset": "openai-compatible",
					"models": [{ "id": "m", "defaults": { "topK": 40 } }]
				}
			}
		}`)).rejects.toThrow("defaults.topK requires compatPreset local, qwen, or deepseek");
	});

	it("model extraBody 不能覆盖核心字段", async () => {
		await expect(
			normalizeFromText(temp.path, `{
				"providers": {
					"vllm": {
						"baseUrl": "http://127.0.0.1:8000/v1",
						"apiKey": "EMPTY",
						"models": [{ "id": "m", "extraBody": { "messages": [] } }]
					}
				}
			}`),
		).rejects.toThrow("models[0].extraBody.messages cannot override core request field");
	});

	it("旧字段给出原生字段迁移提示", async () => {
		await expect(
			normalizeFromText(temp.path, `{
				"providers": { "vllm": { "base_url": "http://127.0.0.1:8000/v1", "api_key": "EMPTY", "models": ["m"] } }
			}`),
		).rejects.toThrow("providers.vllm.base_url was replaced by baseUrl");
	});

	it("schema 错误输出具体 path，未知 compat 输出可选值", async () => {
		await expect(
			normalizeFromText(temp.path, `{
				"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "models": [{}] } }
			}`),
		).rejects.toThrow("providers.vllm.models[0].id is required");

		await expect(
			normalizeFromText(temp.path, `{
				"providers": { "vllm": { "apiKey": "EMPTY", "models": ["m"] } }
			}`),
		).rejects.toThrow("providers.vllm.baseUrl is required");

		await expect(
			normalizeFromText(temp.path, `{
				"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "compatPreset": "foo", "models": ["m"] } }
			}`),
		).rejects.toThrow('unknown compatPreset "foo"');

		await expect(
			normalizeFromText(temp.path, `{
				"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "compat": { "supportsStore": "yes" }, "models": ["m"] } }
			}`),
		).rejects.toThrow();

		const [nativeReasoning] = await normalizeFromText(temp.path, `{
			"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "models": [{ "id": "m", "reasoning": true }] } }
		}`);
		expect(nativeReasoning?.models[0]?.reasoning).toBe(true);

		await expect(
			normalizeFromText(temp.path, `{
				"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "models": [{ "id": "m", "reasoning_effort": "high" }] } }
			}`),
		).rejects.toThrow("reasoning_effort is not supported");

		await expect(
			normalizeFromText(temp.path, `{
				"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "thinkingPreset": "unknown", "models": ["m"] } }
			}`),
		).rejects.toThrow('unknown thinkingPreset "unknown"');

		await expect(
			normalizeFromText(temp.path, `{
				"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "models": [{ "id": "m", "thinkingPreset": "unknown" }] } }
			}`),
		).rejects.toThrow('models[0] has unknown thinkingPreset "unknown"');

		await expect(
			normalizeFromText(temp.path, `{
				"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "models": [{ "id": "m", "defaultThinkingLevel": "max" }] } }
			}`),
		).rejects.toThrow('defaultThinkingLevel "max" is not supported');

		const [maxProvider] = await normalizeFromText(temp.path, `{
			"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "models": [{ "id": "m", "thinkingLevelMap": { "max": "max" } }] } }
		}`);
		expect(maxProvider?.models?.[0]).toMatchObject({
			reasoning: true,
			thinkingLevelMap: { max: "max" },
		});

		await expect(
			normalizeFromText(temp.path, `{
				"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "models": [{ "id": "m", "thinkingLevelMap": { "turbo": "turbo" } }] } }
			}`),
		).rejects.toThrow('thinkingLevelMap contains unknown Pi thinking level "turbo"');

		await expect(
			normalizeFromText(temp.path, `{
				"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "models": [{ "id": "m", "defaultThinkingLevel": "high", "thinkingLevelMap": { "high": null } }] } }
			}`),
		).rejects.toThrow('defaultThinkingLevel "high" is not supported');
	});
});

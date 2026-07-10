import { writeFile } from "node:fs/promises";
import path from "node:path";
import { AuthStorage, ModelRegistry, type ExtensionAPI, type ProviderConfig as PiProviderConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import openAICompatibleProvider from "../../agent/extensions/openai-compatible-provider.js";
import {
	applyRuntimePayloadConfig,
	loadModelsJsoncConfig,
	normalizeModelsJsoncConfig,
	redact_api_key,
	registerOpenAICompatibleProviders,
	resolveAutoModelsJsoncConfig,
} from "../../src/openai-compatible-provider/index.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let dir: string;
const temp = useTempDir("o-pi-models-jsonc-");
preserveEnv("PI_CODING_AGENT_DIR");

beforeEach(() => {
	dir = temp.path;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("openai-compatible-provider config", () => {
	it("扩展入口从 agent 目录加载并注册 provider", async () => {
		process.env.PI_CODING_AGENT_DIR = dir;
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{ "data": [{ "id": "discovered" }] }'));
		await writeFile(
			path.join(dir, "models.jsonc"),
			'{ "providers": { "local": { "base_url": "http://127.0.0.1:8000/v1", "api_key": "EMPTY", "models": ["model"] } } }',
			{ mode: 0o600 },
		);
		const calls: Array<{ name: string; config: PiProviderConfig }> = [];

		await openAICompatibleProvider(createPi(calls));

		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("local");
		expect(calls[0]?.config.models?.map((model) => model.id)).toEqual(["model", "discovered"]);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("不存在 models.jsonc 时不产生 provider 注册输入", async () => {
		const config = await loadModelsJsoncConfig(path.join(dir, "missing.jsonc"));
		const calls: Array<{ name: string; config: PiProviderConfig }> = [];
		if (config) {
			registerOpenAICompatibleProviders(createPi(calls), normalizeModelsJsoncConfig(config, "missing.jsonc"));
		}
		expect(calls).toHaveLength(0);
	});

	it("最小配置能注册 provider，并把字符串模型归一化为同名 model id", async () => {
		const providers = await normalizeFromText(`{
			"providers": {
				"vllm": {
					"display_name": "Local vLLM",
					"base_url": "http://127.0.0.1:8000/v1",
					"api_key": "EMPTY",
					"api": "chat",
					"compat": "local",
					"models": ["Qwen/Qwen3-Coder-480B-A35B-Instruct",],
				},
			},
		}`);
		const calls: Array<{ name: string; config: PiProviderConfig }> = [];
		registerOpenAICompatibleProviders(createPi(calls), providers);

		expect(calls[0]?.name).toBe("vllm");
		expect(calls[0]?.config).toMatchObject({
			name: "Local vLLM",
			baseUrl: "http://127.0.0.1:8000/v1",
			apiKey: "EMPTY",
			api: "openai-completions",
		});
		expect(calls[0]?.config.models?.[0]).toMatchObject({
			id: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
			name: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
		});
	});

	it("同名 provider 注册到 Pi 时完全替换内置 provider 模型", async () => {
		const providers = await normalizeFromText(`{
			"providers": {
				"opencode": {
					"display_name": "Private OpenCode",
					"base_url": "https://private-opencode.example.com/v1",
					"api_key": "EMPTY",
					"models": ["private-opencode-model"]
				}
			}
		}`);
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const builtInModelIds = registry.getAll().filter((model) => model.provider === "opencode").map((model) => model.id);
		expect(builtInModelIds.length).toBeGreaterThan(0);
		expect(builtInModelIds).not.toEqual(["private-opencode-model"]);

		registerOpenAICompatibleProviders(createRegistryPi(registry), providers);

		const models = registry.getAll().filter((model) => model.provider === "opencode");
		expect(models.map((model) => model.id)).toEqual(["private-opencode-model"]);
		expect(models[0]).toMatchObject({
			name: "private-opencode-model",
			baseUrl: "https://private-opencode.example.com/v1",
			api: "openai-completions",
		});
		expect(registry.getProviderDisplayName("opencode")).toBe("Private OpenCode");
	});

	it("对象模型的 model 同时作为 Pi model id 和 API model 名", async () => {
		const [provider] = await normalizeFromText(`{
			"providers": {
				"openrouter": {
					"base_url": "https://openrouter.ai/api/v1",
					"api_key": "$OPENROUTER_API_KEY",
					"models": [{ "model": "deepseek/deepseek-r1", "display_name": "DeepSeek R1" }]
				}
			}
		}`);
		const model = provider?.config.models?.[0];
		expect(model?.id).toBe("deepseek/deepseek-r1");
		expect(model?.name).toBe("DeepSeek R1");
		const runtime = provider?.runtimeModels.get("deepseek/deepseek-r1");
		if (!runtime) throw new Error("runtime config missing");
		expect(applyRuntimePayloadConfig({ model: model?.id, messages: [], stream: true }, runtime)).toMatchObject({
			model: "deepseek/deepseek-r1",
		});
	});

	it("models: auto 会调用 provider models endpoint 并注册发现到的模型", async () => {
		const config = await loadConfigFromText(`{
			"providers": {
				"gateway": {
					"display_name": "Gateway",
					"base_url": "https://gateway.example.com/v1",
					"api_key": "$GATEWAY_API_KEY",
					"models": "auto"
				}
			}
		}`);
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		const resolved = await resolveAutoModelsJsoncConfig(config, path.join(dir, "models.jsonc"), {
			env: { GATEWAY_API_KEY: "sk-test" },
			fetch: async (url, init) => {
				calls.push({ url, headers: init.headers });
				return jsonResponse({
					data: [
						{
							id: "vision-model",
							name: "Vision Model",
							context_length: 200000,
							top_provider: { max_completion_tokens: 8192 },
							architecture: { input_modalities: ["text", "image"] },
						},
					],
				});
			},
		});
		const [provider] = normalizeModelsJsoncConfig(resolved, path.join(dir, "models.jsonc"));

		expect(calls).toEqual([
			{
				url: "https://gateway.example.com/v1/models",
				headers: { Accept: "application/json", Authorization: "Bearer sk-test" },
			},
		]);
		expect(provider?.config.models?.[0]).toMatchObject({
			id: "vision-model",
			name: "Vision Model",
			contextWindow: 200000,
			maxTokens: 8192,
			input: ["text", "image"],
		});
	});

	it("手写 models 会合并 models endpoint，冲突时保留手写配置", async () => {
		const configPath = path.join(dir, "models.jsonc");
		const config = await loadConfigFromText(`{
			"providers": {
				"gateway": {
					"base_url": "https://gateway.example.com/v1",
					"api_key": "EMPTY",
					"models": [
						{
							"model": "manual-model",
							"display_name": "Manual Model",
							"context_window": 1000,
							"max_tokens": 100
						},
						"manual-string"
					]
				}
			}
		}`);
		const calls: string[] = [];
		const resolved = await resolveAutoModelsJsoncConfig(config, configPath, {
			fetch: async (url) => {
				calls.push(url);
				return jsonResponse({
					data: [
						{ id: "manual-model", name: "Endpoint Manual", context_length: 200000, max_completion_tokens: 8192 },
						{ id: "manual-string", name: "Endpoint String", context_length: 200000 },
						{ id: "endpoint-only", name: "Endpoint Only", context_length: 300000 },
					],
				});
			},
		});
		const [provider] = normalizeModelsJsoncConfig(resolved, configPath);
		const models = provider?.config.models ?? [];

		expect(calls).toEqual(["https://gateway.example.com/v1/models"]);
		expect(models.map((model) => model.id)).toEqual(["manual-model", "manual-string", "endpoint-only"]);
		expect(models[0]).toMatchObject({
			id: "manual-model",
			name: "Manual Model",
			contextWindow: 1000,
			maxTokens: 100,
		});
		expect(models[1]).toMatchObject({
			id: "manual-string",
			name: "manual-string",
			contextWindow: 128000,
		});
		expect(models[2]).toMatchObject({
			id: "endpoint-only",
			name: "Endpoint Only",
			contextWindow: 300000,
		});
	});

	it("省略 models 时默认从 /models 自动发现，EMPTY 不发送 Authorization", async () => {
		const config = await loadConfigFromText(`{
			"providers": {
				"local": {
					"base_url": "http://127.0.0.1:8000/v1",
					"api_key": "EMPTY"
				}
			}
		}`);
		let headers: Record<string, string> | undefined;
		const resolved = await resolveAutoModelsJsoncConfig(config, path.join(dir, "models.jsonc"), {
			fetch: async (_url, init) => {
				headers = init.headers;
				return jsonResponse({ data: [{ id: "local-model" }] });
			},
		});
		const [provider] = normalizeModelsJsoncConfig(resolved, path.join(dir, "models.jsonc"));

		expect(headers).toEqual({ Accept: "application/json" });
		expect(provider?.config.models?.[0]?.id).toBe("local-model");
	});

	it("自动发现模型失败时输出 provider 和 HTTP 状态且不泄露 Authorization", async () => {
		const config = await loadConfigFromText(`{
			"providers": {
				"gateway": {
					"base_url": "https://gateway.example.com/v1",
					"api_key": "sk-secret",
					"models": "auto"
				}
			}
		}`);

		await expect(
			resolveAutoModelsJsoncConfig(config, path.join(dir, "models.jsonc"), {
				fetch: async () => jsonResponse({ error: "unauthorized" }, { ok: false, status: 401, statusText: "Unauthorized" }),
			}),
		).rejects.toThrow('provider "gateway" models endpoint returned HTTP 401 Unauthorized');
		await expect(
			resolveAutoModelsJsoncConfig(config, path.join(dir, "models.jsonc"), {
				fetch: async () => jsonResponse({ error: "unauthorized" }, { ok: false, status: 401, statusText: "Unauthorized" }),
			}),
		).rejects.not.toThrow("sk-secret");
	});

	it("api 字段映射到 Pi 当前 OpenAI-compatible API 名称", async () => {
		const providers = await normalizeFromText(`{
			"providers": {
				"chat": { "base_url": "https://example.test/v1", "api_key": "EMPTY", "api": "chat", "models": ["m1"] },
				"responses": { "base_url": "https://example.test/v1", "api_key": "EMPTY", "api": "responses", "models": ["m2"] }
			}
		}`);
		expect(providers.find((provider) => provider.id === "chat")?.config.api).toBe("openai-completions");
		expect(providers.find((provider) => provider.id === "responses")?.config.api).toBe("openai-responses");
	});

	it("compat local 展开为当前 Pi 支持的 compat 字段", async () => {
		const [provider] = await normalizeFromText(`{
			"providers": {
				"vllm": { "base_url": "http://127.0.0.1:8000/v1", "api_key": "EMPTY", "compat": "local", "models": ["m"] }
			}
		}`);
		expect(provider?.config.models?.[0]?.compat).toMatchObject({
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			maxTokensField: "max_tokens",
		});
	});

	it("reasoning_effort 控制模型 reasoning 开关和默认推理强度", async () => {
		const [provider] = await normalizeFromText(`{
			"providers": {
				"gateway": {
					"base_url": "https://example.test/v1",
					"api_key": "EMPTY",
					"models": [
						{ "model": "reasoning-model", "reasoning_effort": "high" },
						{ "model": "plain-model", "reasoning_effort": "off" }
					]
				}
			}
		}`);
		expect(provider?.config.models?.[0]).toMatchObject({ id: "reasoning-model", reasoning: true });
		expect(provider?.config.models?.[1]).toMatchObject({ id: "plain-model", reasoning: false });
		expect(provider?.runtimeModels.get("reasoning-model")?.reasoningEffort).toBe("high");
		expect(provider?.runtimeModels.get("plain-model")?.reasoningEffort).toBe("off");
		const runtime = provider?.runtimeModels.get("reasoning-model");
		if (!runtime) throw new Error("runtime config missing");
		expect(applyRuntimePayloadConfig({ model: "reasoning-model", messages: [], stream: true }, runtime)).toMatchObject({
			reasoning_effort: "high",
		});
	});

	it("注册后在 session_start、before_agent_start 和 model_select 应用 reasoning_effort", async () => {
		const providers = await normalizeFromText(`{
			"providers": {
				"gateway": {
					"base_url": "https://example.test/v1",
					"api_key": "EMPTY",
					"models": [{ "model": "m", "reasoning_effort": "minimal" }]
				}
			}
		}`);
		const calls: Array<{ name: string; config: PiProviderConfig }> = [];
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => void>();
		const thinkingLevels: string[] = [];
		const pi = {
			registerProvider(name: string, config: PiProviderConfig) {
				calls.push({ name, config });
			},
			on(name: string, handler: (event: unknown, ctx?: unknown) => void) {
				handlers.set(name, handler);
			},
			setThinkingLevel(level: string) {
				thinkingLevels.push(level);
			},
		};
		registerOpenAICompatibleProviders(pi as unknown as ExtensionAPI, providers);

		const model = { provider: "gateway", id: "m" };
		handlers.get("session_start")?.({}, { model });
		handlers.get("before_agent_start")?.({}, { model });
		handlers.get("model_select")?.({ model });

		expect(thinkingLevels).toEqual(["minimal", "minimal", "minimal"]);
	});

	it("拒绝 provider 级 defaults 和采样字段，且错误不泄露 api_key", async () => {
		await expect(
			normalizeFromText(`{
				"providers": {
					"vllm": {
						"base_url": "http://127.0.0.1:8000/v1",
						"api_key": "sk-secret",
						"defaults": {},
						"models": ["m"]
					}
				}
			}`),
		).rejects.toThrow('provider "vllm" contains provider-level "defaults"');

		await expect(
			normalizeFromText(`{
				"providers": {
					"vllm": {
						"base_url": "http://127.0.0.1:8000/v1",
						"api_key": "sk-secret",
						"temperature": 0.2,
						"models": ["m"]
					}
				}
			}`),
		).rejects.not.toThrow("sk-secret");
	});

	it("重复 model 报错", async () => {
		await expect(
			normalizeFromText(`{
				"providers": {
					"vllm": {
						"base_url": "http://127.0.0.1:8000/v1",
						"api_key": "EMPTY",
						"models": ["qwen3-coder", { "model": "qwen3-coder" }]
					}
				}
			}`),
		).rejects.toThrow('provider "vllm" contains duplicate model "qwen3-coder"');
	});

	it("api_key 脱敏规则覆盖 literal、env、command、EMPTY 和 missing", () => {
		expect(redact_api_key("sk-secret")).toBe("<literal:redacted>");
		expect(redact_api_key("$OPENROUTER_API_KEY")).toBe("<env:OPENROUTER_API_KEY>");
		expect(redact_api_key("${DEEPSEEK_API_KEY}")).toBe("<env:DEEPSEEK_API_KEY>");
		expect(redact_api_key("!op read op://vault/item/key")).toBe("<command:redacted>");
		expect(redact_api_key("EMPTY")).toBe("<empty-placeholder>");
		expect(redact_api_key(undefined)).toBe("<missing>");
	});

	it("model defaults 被保留并注入 payload，非标准采样只在 local preset 下发送", async () => {
		const [provider] = await normalizeFromText(`{
			"providers": {
				"vllm": {
					"base_url": "http://127.0.0.1:8000/v1",
					"api_key": "EMPTY",
					"compat": "local",
					"models": [{
						"model": "m",
						"defaults": { "temperature": 0.1, "top_p": 0.8, "top_k": 40, "max_tokens": 8192 }
					}]
				}
			}
		}`);
		const runtime = provider?.runtimeModels.get("m");
		expect(runtime?.defaults).toMatchObject({ temperature: 0.1, top_k: 40 });
		if (!runtime) throw new Error("runtime config missing");
		expect(applyRuntimePayloadConfig({ model: "m", messages: [], stream: true, max_tokens: 16384 }, runtime)).toMatchObject({
			model: "m",
			temperature: 0.1,
			top_p: 0.8,
			top_k: 40,
			max_tokens: 8192,
		});
	});

	it("Responses API 的 defaults.max_tokens 注入为 max_output_tokens", async () => {
		const [provider] = await normalizeFromText(`{
			"providers": {
				"gateway": {
					"base_url": "https://gateway.example.com/v1",
					"api_key": "$RESPONSES_GATEWAY_API_KEY",
					"api": "responses",
					"models": [{ "model": "m", "defaults": { "max_tokens": 4096 } }]
				}
			}
		}`);
		const runtime = provider?.runtimeModels.get("m");
		if (!runtime) throw new Error("runtime config missing");
		expect(applyRuntimePayloadConfig({ model: "m", input: [], stream: true }, runtime)).toMatchObject({
			max_output_tokens: 4096,
		});
	});

	it("Responses API 的 reasoning_effort 注入为 reasoning.effort", async () => {
		const [provider] = await normalizeFromText(`{
			"providers": {
				"gateway": {
					"base_url": "https://gateway.example.com/v1",
					"api_key": "$RESPONSES_GATEWAY_API_KEY",
					"api": "responses",
					"models": [{ "model": "m", "reasoning_effort": "low" }]
				}
			}
		}`);
		const runtime = provider?.runtimeModels.get("m");
		if (!runtime) throw new Error("runtime config missing");
		expect(applyRuntimePayloadConfig({ model: "m", input: [], stream: true }, runtime)).toMatchObject({
			reasoning: { effort: "low" },
		});
	});

	it("保留 Pi 已转换的 OpenAI 图片 payload，不把图片 base64 拼入文本", async () => {
		const [chatProvider] = await normalizeFromText(`{
			"providers": {
				"gateway": {
					"base_url": "https://gateway.example.com/v1",
					"api_key": "EMPTY",
					"models": [{ "model": "m", "input": ["text", "image"] }]
				}
			}
		}`);
		const chatRuntime = chatProvider?.runtimeModels.get("m");
		if (!chatRuntime) throw new Error("runtime config missing");
		const chatMessages = [{
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "image_url", image_url: { url: "data:image/gif;base64,R0lGODlhAQAB" } },
			],
		}];
		expect(applyRuntimePayloadConfig({ model: "m", messages: chatMessages, stream: true }, chatRuntime)).toMatchObject({
			messages: chatMessages,
		});

		const [responsesProvider] = await normalizeFromText(`{
			"providers": {
				"gateway": {
					"base_url": "https://gateway.example.com/v1",
					"api_key": "EMPTY",
					"api": "responses",
					"models": [{ "model": "m", "input": ["text", "image"] }]
				}
			}
		}`);
		const responsesRuntime = responsesProvider?.runtimeModels.get("m");
		if (!responsesRuntime) throw new Error("runtime config missing");
		const input = [{
			role: "user",
			content: [
				{ type: "input_text", text: "look" },
				{ type: "input_image", image_url: "data:image/gif;base64,R0lGODlhAQAB" },
			],
		}];
		expect(applyRuntimePayloadConfig({ model: "m", input, stream: true }, responsesRuntime)).toMatchObject({ input });
	});

	it("model advanced.extra_body 不能覆盖核心字段", async () => {
		await expect(
			normalizeFromText(`{
				"providers": {
					"vllm": {
						"base_url": "http://127.0.0.1:8000/v1",
						"api_key": "EMPTY",
						"models": [{ "model": "m", "advanced": { "extra_body": { "messages": [] } } }]
					}
				}
			}`),
		).rejects.toThrow("advanced.extra_body.messages cannot override core request field");
	});

	it("provider advanced headers 传给 registerProvider，extra_body 与 drop_params 合并", async () => {
		const [provider] = await normalizeFromText(`{
			"providers": {
				"openrouter": {
					"base_url": "https://openrouter.ai/api/v1",
					"api_key": "$OPENROUTER_API_KEY",
					"advanced": {
						"headers": { "HTTP-Referer": "https://example.local" },
						"drop_params": ["store"],
						"extra_body": { "provider": { "only": ["openai"] } }
					},
					"models": [{ "model": "m", "advanced": { "drop_params": ["parallel_tool_calls"], "extra_body": { "top_p": 0.9 } } }]
				}
			}
		}`);
		expect(provider?.config.headers).toEqual({ "HTTP-Referer": "https://example.local" });
		const runtime = provider?.runtimeModels.get("m");
		expect(runtime?.dropParams).toEqual(["store", "parallel_tool_calls"]);
		if (!runtime) throw new Error("runtime config missing");
		expect(applyRuntimePayloadConfig({ model: "m", messages: [], stream: true, store: false }, runtime)).toMatchObject({
			provider: { only: ["openai"] },
			top_p: 0.9,
		});
		expect(applyRuntimePayloadConfig({ model: "m", messages: [], stream: true, store: false }, runtime)).not.toHaveProperty("store");
	});

	it("schema 错误输出具体 path，未知 compat 输出可选值", async () => {
		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "base_url": "http://127.0.0.1:8000/v1", "api_key": "EMPTY", "models": [{}] } }
			}`),
		).rejects.toThrow("providers.vllm.models[0].model is required");

		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "api_key": "EMPTY", "models": ["m"] } }
			}`),
		).rejects.toThrow("providers.vllm.base_url is required");

		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "base_url": "http://127.0.0.1:8000/v1", "api_key": "EMPTY", "compat": "foo", "models": ["m"] } }
			}`),
		).rejects.toThrow('unknown compat preset "foo"');

		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "base_url": "http://127.0.0.1:8000/v1", "api_key": "EMPTY", "models": [{ "model": "m", "reasoning": true }] } }
			}`),
		).rejects.toThrow("providers.vllm.models[0].reasoning is not supported");

		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "base_url": "http://127.0.0.1:8000/v1", "api_key": "EMPTY", "models": [{ "model": "m", "reasoning_effort": "max" }] } }
			}`),
		).rejects.toThrow("providers.vllm.models[0].reasoning_effort");
	});
});

async function normalizeFromText(text: string) {
	const file = path.join(dir, "models.jsonc");
	const config = await loadConfigFromText(text);
	return normalizeModelsJsoncConfig(config, file);
}

async function loadConfigFromText(text: string) {
	const file = path.join(dir, "models.jsonc");
	await writeFile(file, text);
	const config = await loadModelsJsoncConfig(file);
	if (!config) throw new Error("config unexpectedly missing");
	return config;
}

function jsonResponse(value: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) {
	const response = {
		ok: init.ok ?? true,
		status: init.status ?? 200,
		async text() {
			return JSON.stringify(value);
		},
	};
	return init.statusText === undefined ? response : { ...response, statusText: init.statusText };
}

function createPi(calls: Array<{ name: string; config: PiProviderConfig }>): ExtensionAPI {
	return {
		registerProvider(name: string, config: PiProviderConfig) {
			calls.push({ name, config });
		},
		on() {},
		setThinkingLevel() {},
	} as unknown as ExtensionAPI;
}

function createRegistryPi(registry: ModelRegistry): ExtensionAPI {
	return {
		registerProvider(name: string, config: PiProviderConfig) {
			registry.registerProvider(name, config);
		},
		on() {},
		setThinkingLevel() {},
	} as unknown as ExtensionAPI;
}

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type ModelsStoreEntry,
	type Provider,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import openAICompatibleProvider from "../../agent/extensions/openai-compatible-provider.js";
import {
	applyRuntimePayloadConfig,
	createProviderAuth,
	resolveRefreshAuth,
	loadModelsJsoncConfig,
	normalizeModelsJsoncConfig,
	redactApiKey,
	registerOpenAICompatibleProviders,
	fetchProviderModelsFromEndpoint,
	type ModelsJsoncConfig,
} from "../../src/openai-compatible-provider/index.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let dir: string;
const temp = useTempDir("o-pi-models-jsonc-");
preserveEnv("PI_CODING_AGENT_DIR");
preserveEnv("PI_OFFLINE");
preserveEnv("HOME");

beforeEach(() => {
	dir = temp.path;
	process.env.HOME = dir;
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("openai-compatible-provider config", () => {
	it("仓库示例配置与当前 schema 同步", async () => {
		const config = await loadModelsJsoncConfig(path.resolve("agent/models.jsonc.example"));
		expect(config?.providers["llama-cpp"]?.api).toBe("openai-responses");
	});

	it("扩展只注册完整原生 Provider，启动阶段不自行联网", async () => {
		process.env.PI_CODING_AGENT_DIR = dir;
		const fetch = vi.spyOn(globalThis, "fetch");
		await writeFile(
			path.join(dir, "models.jsonc"),
			'{ "providers": { "local": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "models": ["manual"] } } }',
			{ mode: 0o600 },
		);
		const harness = createExtensionHarness();

		await openAICompatibleProvider(harness.pi);

		expect(harness.providers).toHaveLength(1);
		expect(harness.providers[0]).toMatchObject({ id: "local", baseUrl: "http://127.0.0.1:8000/v1" });
		expect(harness.providers[0]?.getModels().map((model) => model.id)).toEqual(["manual"]);
		expect(harness.providers[0]?.refreshModels).toBeTypeOf("function");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("原生 auth 正确解析 env/header，并让 EMPTY provider 真正无 Authorization", async () => {
		const ctx = {
			env: async (name: string) => ({ KEY: "sk-test", TOKEN: "header-token" })[name],
			fileExists: async () => false,
		};
		const configured = createProviderAuth("gateway", {
			baseUrl: "https://gateway.test/v1",
			apiKey: "$KEY",
			headers: { "X-Token": "$TOKEN" },
		});
		await expect(configured.resolve({ ctx })).resolves.toMatchObject({
			auth: { apiKey: "sk-test", headers: { "X-Token": "header-token" } },
			source: "KEY",
		});

		const keyless = createProviderAuth("local", {
			baseUrl: "http://127.0.0.1:8000/v1",
			apiKey: "EMPTY",
		});
		await expect(keyless.resolve({ ctx })).resolves.toMatchObject({
			auth: { apiKey: "unused", headers: { Authorization: null } },
			source: "keyless provider",
		});
		const keylessConfig = {
			baseUrl: "http://127.0.0.1:8000/v1",
			apiKey: "EMPTY",
		} as const;
		expect(resolveRefreshAuth("local", keylessConfig, { type: "api_key", key: "sk-runtime" })).toMatchObject({
			apiKey: "sk-runtime",
			keyless: false,
		});
		expect(resolveRefreshAuth("local", keylessConfig, { type: "api_key", key: "unused" })).toMatchObject({
			apiKey: "unused",
			keyless: false,
		});

		const incomplete = createProviderAuth("incomplete", {
			baseUrl: "https://gateway.test/v1",
			apiKey: "sk-test",
			headers: { "X-Account": "$MISSING_ACCOUNT" },
		});
		await expect(incomplete.check?.({ ctx })).resolves.toBeUndefined();
	});

	it("auth check 不执行命令，resolve 才在请求边界执行并缓存结果", async () => {
		const marker = path.join(dir, "auth-command-ran");
		const auth = createProviderAuth("command", {
			baseUrl: "https://gateway.test/v1",
			apiKey: `!printf ran >> ${marker}; printf sk-command`,
		});
		const ctx = { env: async () => undefined, fileExists: async () => false };

		await expect(auth.check?.({ ctx })).resolves.toMatchObject({ type: "api_key" });
		await expect(readFile(marker, "utf8")).rejects.toThrow();
		await expect(auth.resolve({ ctx })).resolves.toMatchObject({ auth: { apiKey: "sk-command" } });
		await expect(auth.resolve({ ctx })).resolves.toMatchObject({ auth: { apiKey: "sk-command" } });
		expect(await readFile(marker, "utf8")).toBe("ran");
	});

	it("原生 Provider 从 Pi ModelsStore 恢复动态目录且不覆盖手写模型", async () => {
		const config = await loadConfigFromText(`{
			"providers": {
				"local": {
					"baseUrl": "http://127.0.0.1:8000/v1",
					"apiKey": "EMPTY",
					"models": [{ "id": "manual", "name": "Manual" }]
				}
			}
		}`);
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{ "data": [{ "id": "manual", "name": "Remote" }, { "id": "dynamic" }] }'));
		const stores = new Map<string, ModelsStoreEntry>();
		const store = {
			read: async () => stores.get("local"),
			write: async (entry: ModelsStoreEntry) => { stores.set("local", entry); },
			delete: async () => { stores.delete("local"); },
		};
		const firstHarness = createExtensionHarness();
		const [first] = registerOpenAICompatibleProviders(firstHarness.pi, config, path.join(dir, "models.jsonc"));
		await first?.refreshModels?.({ credential: { type: "api_key", key: "unused" }, store, allowNetwork: true });
		expect(first?.getModels().map((model) => [model.id, model.name])).toEqual([
			["manual", "Manual"],
			["dynamic", "dynamic"],
		]);

		const stored = stores.get("local");
		if (!stored?.models[0]) throw new Error("dynamic model was not stored");
		stores.set("local", {
			...stored,
			models: [
				{ ...stored.models[0], id: "manual", name: "Stale Remote Manual", baseUrl: "https://stale.test/v1" },
				...stored.models,
			],
		});
		const secondHarness = createExtensionHarness();
		const [second] = registerOpenAICompatibleProviders(secondHarness.pi, config, path.join(dir, "models.jsonc"));
		await second?.refreshModels?.({ credential: { type: "api_key", key: "unused" }, store, allowNetwork: false });
		expect(second?.getModels().map((model) => [model.id, model.name, model.baseUrl])).toEqual([
			["manual", "Manual", "http://127.0.0.1:8000/v1"],
			["dynamic", "dynamic", "http://127.0.0.1:8000/v1"],
		]);

		stores.delete("local");
		fetch.mockRejectedValueOnce(new Error("offline"));
		await expect(second?.refreshModels?.({
			credential: { type: "api_key", key: "unused" },
			store,
			allowNetwork: true,
		})).rejects.toThrow("offline");
		expect(second?.getModels().map((model) => model.id)).toEqual(["manual", "dynamic"]);
		stores.set("local", stored);

		fetch.mockResolvedValueOnce(new Response('{ "data": [{ "id": "replacement" }] }'));
		await expect(second?.refreshModels?.({
			credential: { type: "api_key", key: "unused" },
			store: { ...store, write: async () => { throw new Error("store failed"); } },
			allowNetwork: true,
		})).rejects.toThrow("store failed");
		expect(second?.getModels().map((model) => model.id)).toEqual(["manual", "dynamic"]);

		const changedConfig = await loadConfigFromText(`{
			"providers": {
				"local": {
					"baseUrl": "http://127.0.0.1:9000/v1",
					"apiKey": "EMPTY",
					"models": ["manual"]
				}
			}
		}`);
		const thirdHarness = createExtensionHarness();
		const [third] = registerOpenAICompatibleProviders(thirdHarness.pi, changedConfig, path.join(dir, "models.jsonc"));
		await third?.refreshModels?.({ credential: { type: "api_key", key: "unused" }, store, allowNetwork: false });
		expect(third?.getModels().map((model) => model.id)).toEqual(["manual"]);
		expect(globalThis.fetch).toHaveBeenCalledTimes(3);
	});

	it("在线刷新会等待进行中的离线恢复并继续请求网络", async () => {
		const config = await loadConfigFromText(`{
			"providers": { "local": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY" } }
		}`);
		const harness = createExtensionHarness();
		const [provider] = registerOpenAICompatibleProviders(harness.pi, config, path.join(dir, "models.jsonc"));
		if (!provider?.refreshModels) throw new Error("refreshModels missing");
		let releaseRead: (() => void) | undefined;
		let readCount = 0;
		const firstRead = new Promise<void>((resolve) => { releaseRead = resolve; });
		const store = {
			read: async () => {
				readCount++;
				if (readCount === 1) await firstRead;
				return undefined;
			},
			write: async () => undefined,
			delete: async () => undefined,
		};
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{ "data": [{ "id": "dynamic" }] }'));

		const offline = provider.refreshModels({ credential: { type: "api_key", key: "unused" }, store, allowNetwork: false });
		const online = provider.refreshModels({ credential: { type: "api_key", key: "unused" }, store, allowNetwork: true });
		releaseRead?.();
		await Promise.all([offline, online]);

		expect(readCount).toBe(2);
		expect(fetch).toHaveBeenCalledOnce();
		expect(provider.getModels().map((model) => model.id)).toEqual(["dynamic"]);
	});

	it("不存在 models.jsonc 时不产生 provider 注册输入", async () => {
		expect(await loadModelsJsoncConfig(path.join(dir, "missing.jsonc"))).toBeUndefined();
	});

	it("最小配置注册为完整原生 provider，并把字符串模型归一化为同名 model id", async () => {
		const config = await loadConfigFromText(`{
			"providers": {
				"vllm": {
					"name": "Local vLLM",
					"baseUrl": "http://127.0.0.1:8000/v1",
					"apiKey": "EMPTY",
					"api": "openai-completions",
					"compatPreset": "local",
					"models": ["Qwen/Qwen3-Coder-480B-A35B-Instruct",],
				},
			},
		}`);
		const harness = createExtensionHarness();
		const [provider] = registerOpenAICompatibleProviders(harness.pi, config, path.join(dir, "models.jsonc"));

		expect(provider).toMatchObject({
			id: "vllm",
			name: "Local vLLM",
			baseUrl: "http://127.0.0.1:8000/v1",
		});
		expect(provider?.getModels()[0]).toMatchObject({
			id: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
			name: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
			api: "openai-completions",
		});
	});

	it("同名 provider 注册到 Pi 时完全替换内置 provider 模型", async () => {
		const config = await loadConfigFromText(`{
			"providers": {
				"opencode": {
					"name": "Private OpenCode",
					"baseUrl": "https://private-opencode.example.com/v1",
					"apiKey": "EMPTY",
					"models": ["private-opencode-model"]
				}
			}
		}`);
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});
		const registry = new ModelRegistry(runtime);
		const builtInModelIds = registry.getAll().filter((model) => model.provider === "opencode").map((model) => model.id);
		expect(builtInModelIds.length).toBeGreaterThan(0);
		expect(builtInModelIds).not.toEqual(["private-opencode-model"]);

		registerOpenAICompatibleProviders(createRegistryPi(registry), config, path.join(dir, "models.jsonc"));

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

	it("models: auto 会调用 provider models endpoint 并注册发现到的模型", async () => {
		const config = await loadConfigFromText(`{
			"providers": {
				"gateway": {
					"name": "Gateway",
					"baseUrl": "https://gateway.example.com/v1",
					"apiKey": "$GATEWAY_API_KEY",
					"models": "auto"
				}
			}
		}`);
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		const provider = await fetchNormalizedProvider(config, "gateway", path.join(dir, "models.jsonc"), {
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

		expect(calls).toEqual([
			{
				url: "https://gateway.example.com/v1/models",
				headers: { Accept: "application/json", Authorization: "Bearer sk-test" },
			},
		]);
		expect(provider?.models?.[0]).toMatchObject({
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
					"baseUrl": "https://gateway.example.com/v1",
					"apiKey": "EMPTY",
					"models": [
						{
							"id": "manual-model",
							"name": "Manual Model",
							"contextWindow": 1000,
							"maxTokens": 100
						},
						"manual-string"
					]
				}
			}
		}`);
		const calls: string[] = [];
		const provider = await fetchNormalizedProvider(config, "gateway", configPath, {
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
		const models = provider?.models ?? [];

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
					"baseUrl": "http://127.0.0.1:8000/v1",
					"apiKey": "EMPTY"
				}
			}
		}`);
		let headers: Record<string, string> | undefined;
		const provider = await fetchNormalizedProvider(config, "local", path.join(dir, "models.jsonc"), {
			fetch: async (_url, init) => {
				headers = init.headers;
				return jsonResponse({ data: [{ id: "local-model" }] });
			},
		});

		expect(headers).toEqual({ Accept: "application/json" });
		expect(provider?.models?.[0]?.id).toBe("local-model");
	});

	it("自动发现模型失败时输出 provider 和 HTTP 状态且不泄露 Authorization", async () => {
		const config = await loadConfigFromText(`{
			"providers": {
				"gateway": {
					"baseUrl": "https://gateway.example.com/v1",
					"apiKey": "sk-secret",
					"models": "auto"
				}
			}
		}`);

		await expect(
			fetchNormalizedProvider(config, "gateway", path.join(dir, "models.jsonc"), {
				fetch: async () => jsonResponse({ error: "unauthorized" }, { ok: false, status: 401, statusText: "Unauthorized" }),
			}),
		).rejects.toThrow('provider "gateway" models endpoint returned HTTP 401 Unauthorized');
		await expect(
			fetchNormalizedProvider(config, "gateway", path.join(dir, "models.jsonc"), {
				fetch: async () => jsonResponse({ error: "unauthorized" }, { ok: false, status: 401, statusText: "Unauthorized" }),
			}),
		).rejects.not.toThrow("sk-secret");
	});

	it("模型发现超时覆盖响应 body 读取", async () => {
		vi.useFakeTimers();
		const config = await loadConfigFromText(`{
			"providers": {
				"gateway": { "baseUrl": "https://gateway.example.com/v1", "apiKey": "EMPTY", "models": "auto" }
			}
		}`);
		const promise = fetchNormalizedProvider(config, "gateway", path.join(dir, "models.jsonc"), {
			timeoutMs: 10,
			fetch: async (_url, init) => ({
				ok: true,
				status: 200,
				text: () => new Promise<string>((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
				}),
			}),
		});
		const rejected = expect(promise).rejects.toThrow("response cannot be read");

		await vi.advanceTimersByTimeAsync(10);
		await rejected;
	});

	it("直接采用 Pi 原生 api/model 字段，并允许模型级覆盖", async () => {
		const [provider] = await normalizeFromText(`{
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
		const [provider] = await normalizeFromText(`{
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
		const [provider] = await normalizeFromText(`{
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
		const [provider] = await normalizeFromText(`{
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
		const [provider] = await normalizeFromText(`{
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
		const [provider] = await normalizeFromText(`{
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

	it("只在用户选择模型时应用 defaultThinkingLevel，不覆盖恢复值或每轮用户选择", async () => {
		const config = await loadConfigFromText(`{
			"providers": {
				"gateway": {
					"baseUrl": "https://example.test/v1",
					"apiKey": "EMPTY",
					"thinkingPreset": "openai",
					"models": [{ "id": "m", "defaultThinkingLevel": "minimal" }]
				}
			}
		}`);
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => void>();
		const thinkingLevels: string[] = [];
		const pi = {
			registerProvider() {},
			on(name: string, handler: (event: unknown, ctx?: unknown) => void) {
				handlers.set(name, handler);
			},
			setThinkingLevel(level: string) {
				thinkingLevels.push(level);
			},
		};
		registerOpenAICompatibleProviders(pi as unknown as ExtensionAPI, config, path.join(dir, "models.jsonc"));

		const model = { provider: "gateway", id: "m" };
		handlers.get("session_start")?.({ reason: "new" }, { model });
		handlers.get("before_agent_start")?.({}, { model });
		handlers.get("model_select")?.({ model, source: "restore" });
		handlers.get("model_select")?.({ model, source: "set" });

		expect(thinkingLevels).toEqual(["minimal"]);
	});

	it("拒绝 provider 级 defaults 和采样字段，且错误不泄露 apiKey", async () => {
		await expect(
			normalizeFromText(`{
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
			normalizeFromText(`{
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
			normalizeFromText(`{
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

	it("apiKey 脱敏规则覆盖 literal、env、command、EMPTY 和 missing", () => {
		expect(redactApiKey("sk-secret")).toBe("<literal:redacted>");
		expect(redactApiKey("$OPENROUTER_API_KEY")).toBe("<env:OPENROUTER_API_KEY>");
		expect(redactApiKey("${DEEPSEEK_API_KEY}")).toBe("<env:DEEPSEEK_API_KEY>");
		expect(redactApiKey("!op read op://vault/item/key")).toBe("<command:redacted>");
		expect(redactApiKey("EMPTY")).toBe("<empty-placeholder>");
		expect(redactApiKey(undefined)).toBe("<missing>");
	});

	it("model defaults 补缺失字段，defaults.maxTokens 设置请求上限", async () => {
		const [provider] = await normalizeFromText(`{
			"providers": {
				"vllm": {
					"baseUrl": "http://127.0.0.1:8000/v1",
					"apiKey": "EMPTY",
					"compatPreset": "local",
					"models": [{
						"id": "m",
						"defaults": { "temperature": 0.1, "topP": 0.8, "topK": 40, "maxTokens": 8192 }
					}]
				}
			}
		}`);
		const runtime = provider?.runtimeModels.get("m");
		expect(runtime?.defaults).toMatchObject({ temperature: 0.1, topK: 40 });
		if (!runtime) throw new Error("runtime config missing");
		expect(applyRuntimePayloadConfig({ model: "m", messages: [], stream: true, max_tokens: 16384 }, runtime)).toMatchObject({
			model: "m",
			temperature: 0.1,
			top_p: 0.8,
			top_k: 40,
			max_tokens: 8192,
		});
		expect(applyRuntimePayloadConfig({ model: "m", messages: [], stream: true, max_tokens: 4096 }, runtime)).toMatchObject({
			max_tokens: 4096,
		});
	});

	it("不兼容的非标准 defaults 会报错而不是静默丢弃", async () => {
		await expect(normalizeFromText(`{
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

	it("原生低层 stream 保留 payload 修改，并转换 Responses 非 OpenAI thinking preset", async () => {
		const config = await loadConfigFromText(`{
			"providers": {
				"gateway": {
					"baseUrl": "https://gateway.example.com/v1",
					"apiKey": "EMPTY",
					"api": "openai-responses",
					"headers": { "x-model": "provider-header" },
					"thinkingPreset": "deepseek",
					"maxRetries": 0,
					"dropParams": ["store"],
					"extraBody": { "custom": true },
					"models": [{
						"id": "m",
						"defaultThinkingLevel": "high",
						"maxTokens": 32768,
						"headers": { "X-Model": "$MODEL_HEADER" },
						"defaults": { "temperature": 0.2, "maxTokens": 8192 }
					}]
				}
			}
		}`);
		const harness = createExtensionHarness();
		const [provider] = registerOpenAICompatibleProviders(harness.pi, config, path.join(dir, "models.jsonc"));
		const model = provider?.getModels()[0];
		if (!provider || !model) throw new Error("provider model missing");
		let requestBody: unknown;
		const modelHeaders: Array<string | null> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			requestBody = JSON.parse(String(init?.body));
			modelHeaders.push(new Headers(init?.headers).get("X-Model"));
			return new Response('{"error":"stop after payload"}', { status: 400, headers: { "Content-Type": "application/json" } });
		});

		const auth = await provider.auth.apiKey?.resolve({
			ctx: { env: async () => undefined, fileExists: async () => false },
		});
		if (!auth) throw new Error("provider auth missing");
		const streamOnce = async (headers: Record<string, string | null>): Promise<void> => {
			for await (const _event of provider.stream(model, {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			}, {
				...(auth.auth.apiKey !== undefined ? { apiKey: auth.auth.apiKey } : {}),
				headers,
				env: { ...auth.env, MODEL_HEADER: "resolved-model-header" },
				reasoningEffort: "high",
				onPayload: () => undefined,
			})) {
				// Consume the terminal error event.
			}
		};
		await streamOnce(auth.auth.headers ?? {});
		await streamOnce({ Authorization: null, "X-MODEL": "caller-header" });
		for await (const _event of provider.streamSimple(model, {
			messages: [{ role: "user", content: "test", timestamp: Date.now() }],
		}, {
			...(auth.auth.apiKey !== undefined ? { apiKey: auth.auth.apiKey } : {}),
			...(auth.auth.headers !== undefined ? { headers: auth.auth.headers } : {}),
			env: { ...auth.env, MODEL_HEADER: "resolved-model-header" },
			reasoning: "high",
		})) {
			// Consume the terminal error event.
		}

		expect(requestBody).toMatchObject({
			model: "m",
			temperature: 0.2,
			thinking: { type: "enabled" },
			custom: true,
			max_output_tokens: 8192,
		});
		expect(modelHeaders).toEqual(["resolved-model-header", "caller-header", "resolved-model-header"]);
		expect(requestBody).not.toHaveProperty("reasoning");
		expect(requestBody).not.toHaveProperty("store");
	});

	it("Responses API 的 defaults.maxTokens 注入为 max_output_tokens", async () => {
		const [provider] = await normalizeFromText(`{
			"providers": {
				"gateway": {
					"baseUrl": "https://gateway.example.com/v1",
					"apiKey": "$RESPONSES_GATEWAY_API_KEY",
					"api": "openai-responses",
					"models": [{ "id": "m", "defaults": { "maxTokens": 4096 } }]
				}
			}
		}`);
		const runtime = provider?.runtimeModels.get("m");
		if (!runtime) throw new Error("runtime config missing");
		expect(applyRuntimePayloadConfig({ model: "m", input: [], stream: true }, runtime)).toMatchObject({
			max_output_tokens: 4096,
		});
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
	] as const)("Responses API 将 %s thinking preset 编码到 payload", async (thinking, level, expected) => {
		const [provider] = await normalizeFromText(`{
			"providers": {
				"gateway": {
					"baseUrl": "https://gateway.example.com/v1",
					"apiKey": "$RESPONSES_GATEWAY_API_KEY",
					"api": "openai-responses",
					"thinkingPreset": "${thinking}",
					"models": [{ "id": "m", "defaultThinkingLevel": "${level}" }]
				}
			}
		}`);
		const runtime = provider?.runtimeModels.get("m");
		if (!runtime) throw new Error("runtime config missing");
		const payload = applyRuntimePayloadConfig({
			model: "m",
			input: [],
			stream: true,
			reasoning: { effort: level },
			include: ["reasoning.encrypted_content"],
		}, runtime, level);
		expect(payload).toMatchObject(expected);
		expect(payload).not.toHaveProperty("include");
	});

	it("Responses chat-template-effort 使用 Pi thinkingLevelMap 的上游值", async () => {
		const [provider] = await normalizeFromText(`{
			"providers": {
				"thor": {
					"baseUrl": "http://thor:11451/v1",
					"apiKey": "EMPTY",
					"api": "openai-responses",
					"thinkingPreset": "chat-template-effort",
					"models": [{
						"id": "hy3",
						"defaultThinkingLevel": "xhigh",
						"thinkingLevelMap": { "off": "disabled", "xhigh": "max" }
					}]
				}
			}
		}`);
		const model = provider?.models?.[0];
		const runtime = provider?.runtimeModels.get("hy3");
		if (!runtime) throw new Error("runtime config missing");
		expect(model?.thinkingLevelMap).toEqual({ off: "disabled", xhigh: "max" });
		expect(applyRuntimePayloadConfig({
			model: "hy3",
			input: [],
			stream: true,
			reasoning: { effort: "max" },
			include: ["reasoning.encrypted_content"],
		}, runtime, "xhigh")).toMatchObject({
			chat_template_kwargs: { reasoning_effort: "max" },
		});
	});

	it("Responses 的 openai 保留 Pi payload，none 移除 Pi reasoning 字段", async () => {
		const providers = await normalizeFromText(`{
			"providers": {
				"standard": {
					"baseUrl": "https://standard.example.com/v1",
					"apiKey": "EMPTY",
					"api": "openai-responses",
					"thinkingPreset": "openai",
					"models": [{ "id": "m", "defaultThinkingLevel": "high" }]
				},
				"fixed": {
					"baseUrl": "https://fixed.example.com/v1",
					"apiKey": "EMPTY",
					"api": "openai-responses",
					"thinkingPreset": "none",
					"models": [{ "id": "m", "defaultThinkingLevel": "high" }]
				}
			}
		}`);
		const payload = {
			model: "m",
			input: [],
			stream: true,
			reasoning: { effort: "high" },
			include: ["reasoning.encrypted_content"],
		};
		const standard = providers.find((provider) => provider.id === "standard")?.runtimeModels.get("m");
		const fixed = providers.find((provider) => provider.id === "fixed")?.runtimeModels.get("m");
		if (!standard || !fixed) throw new Error("runtime config missing");
		expect(applyRuntimePayloadConfig(payload, standard, "high")).toMatchObject({
			reasoning: { effort: "high" },
			include: ["reasoning.encrypted_content"],
		});
		expect(applyRuntimePayloadConfig(payload, fixed, "high")).not.toHaveProperty("reasoning");
		expect(applyRuntimePayloadConfig(payload, fixed, "high")).not.toHaveProperty("include");
	});

	it("Responses 使用 Pi map 为 ant-ling 和支持 effort 的 deepseek 生成 provider 值", async () => {
		const providers = await normalizeFromText(`{
			"providers": {
				"ant": {
					"baseUrl": "https://ant.example.com/v1",
					"apiKey": "EMPTY",
					"api": "openai-responses",
					"thinkingPreset": "ant-ling",
					"models": [{ "id": "m", "defaultThinkingLevel": "high", "thinkingLevelMap": { "high": "max" } }]
				},
				"deep": {
					"baseUrl": "https://deep.example.com/v1",
					"apiKey": "EMPTY",
					"api": "openai-responses",
					"thinkingPreset": "deepseek",
					"models": [{
						"id": "m",
						"defaultThinkingLevel": "high",
						"thinkingLevelMap": { "high": "max" },
						"compat": { "supportsReasoningEffort": true }
					}]
				}
			}
		}`);
		const ant = providers.find((provider) => provider.id === "ant")?.runtimeModels.get("m");
		const deep = providers.find((provider) => provider.id === "deep")?.runtimeModels.get("m");
		if (!ant || !deep) throw new Error("runtime config missing");
		expect(applyRuntimePayloadConfig({ model: "m", input: [], stream: true }, ant, "high")).toMatchObject({
			reasoning: { effort: "max" },
		});
		expect(applyRuntimePayloadConfig({ model: "m", input: [], stream: true }, deep, "high")).toMatchObject({
			thinking: { type: "enabled" },
			reasoning_effort: "max",
		});
	});

	it("保留 Pi 已转换的 OpenAI 图片 payload，不把图片 base64 拼入文本", async () => {
		const [chatProvider] = await normalizeFromText(`{
			"providers": {
				"gateway": {
					"baseUrl": "https://gateway.example.com/v1",
					"apiKey": "EMPTY",
					"models": [{ "id": "m", "input": ["text", "image"] }]
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
					"baseUrl": "https://gateway.example.com/v1",
					"apiKey": "EMPTY",
					"api": "openai-responses",
					"models": [{ "id": "m", "input": ["text", "image"] }]
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

	it("model extraBody 不能覆盖核心字段", async () => {
		await expect(
			normalizeFromText(`{
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

	it("provider 原生 headers 与扩展 payload 字段直接配置，model 字段覆盖或追加", async () => {
		const [provider] = await normalizeFromText(`{
			"providers": {
				"openrouter": {
					"baseUrl": "https://openrouter.ai/api/v1",
					"apiKey": "$OPENROUTER_API_KEY",
					"headers": { "HTTP-Referer": "https://example.local" },
					"dropParams": ["store"],
					"extraBody": { "provider": { "only": ["openai"] } },
					"models": [{ "id": "m", "dropParams": ["parallel_tool_calls"], "extraBody": { "top_p": 0.9 } }]
				}
			}
		}`);
		expect(provider?.fallbackRuntime).toBeDefined();
		const runtime = provider?.runtimeModels.get("m");
		expect(runtime?.dropParams).toEqual(["store", "parallel_tool_calls"]);
		if (!runtime) throw new Error("runtime config missing");
		expect(applyRuntimePayloadConfig({ model: "m", messages: [], stream: true, store: false }, runtime)).toMatchObject({
			provider: { only: ["openai"] },
			top_p: 0.9,
		});
		expect(applyRuntimePayloadConfig({ model: "m", messages: [], stream: true, store: false }, runtime)).not.toHaveProperty("store");
	});

	it("旧字段给出原生字段迁移提示", async () => {
		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "base_url": "http://127.0.0.1:8000/v1", "api_key": "EMPTY", "models": ["m"] } }
			}`),
		).rejects.toThrow("providers.vllm.base_url was replaced by baseUrl");
	});

	it("schema 错误输出具体 path，未知 compat 输出可选值", async () => {
		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "models": [{}] } }
			}`),
		).rejects.toThrow("providers.vllm.models[0].id is required");

		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "apiKey": "EMPTY", "models": ["m"] } }
			}`),
		).rejects.toThrow("providers.vllm.baseUrl is required");

		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "compatPreset": "foo", "models": ["m"] } }
			}`),
		).rejects.toThrow('unknown compatPreset "foo"');

		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "compat": { "supportsStore": "yes" }, "models": ["m"] } }
			}`),
		).rejects.toThrow();

		const [nativeReasoning] = await normalizeFromText(`{
			"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "models": [{ "id": "m", "reasoning": true }] } }
		}`);
		expect(nativeReasoning?.models[0]?.reasoning).toBe(true);

		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "models": [{ "id": "m", "reasoning_effort": "high" }] } }
			}`),
		).rejects.toThrow("reasoning_effort is not supported");

		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "thinkingPreset": "unknown", "models": ["m"] } }
			}`),
		).rejects.toThrow('unknown thinkingPreset "unknown"');

		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "models": [{ "id": "m", "thinkingPreset": "unknown" }] } }
			}`),
		).rejects.toThrow('models[0] has unknown thinkingPreset "unknown"');

		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "models": [{ "id": "m", "defaultThinkingLevel": "max" }] } }
			}`),
		).rejects.toThrow('defaultThinkingLevel "max" is not supported');

		const [maxProvider] = await normalizeFromText(`{
			"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "models": [{ "id": "m", "thinkingLevelMap": { "max": "max" } }] } }
		}`);
		expect(maxProvider?.models?.[0]).toMatchObject({
			reasoning: true,
			thinkingLevelMap: { max: "max" },
		});

		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "models": [{ "id": "m", "thinkingLevelMap": { "turbo": "turbo" } }] } }
			}`),
		).rejects.toThrow('thinkingLevelMap contains unknown Pi thinking level "turbo"');

		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY", "models": [{ "id": "m", "defaultThinkingLevel": "high", "thinkingLevelMap": { "high": null } }] } }
			}`),
		).rejects.toThrow('defaultThinkingLevel "high" is not supported');
	});
});

async function fetchNormalizedProvider(
	config: ModelsJsoncConfig,
	providerId: string,
	configPath: string,
	options: Parameters<typeof fetchProviderModelsFromEndpoint>[3],
) {
	const source = config.providers[providerId];
	if (!source) throw new Error(`provider ${providerId} missing`);
	const discovered = await fetchProviderModelsFromEndpoint(providerId, source, configPath, options);
	const configured = Array.isArray(source.models) ? source.models : [];
	const configuredIds = new Set(configured.map((model) => typeof model === "string" ? model : model.id));
	const [provider] = normalizeModelsJsoncConfig({
		providers: {
			[providerId]: {
				...source,
				models: [...configured, ...discovered.filter((model) => !configuredIds.has(model.id))],
			},
		},
	}, configPath);
	if (!provider) throw new Error(`provider ${providerId} was not normalized`);
	return provider;
}

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

interface ExtensionHarness {
	pi: ExtensionAPI;
	providers: Provider[];
}

function createExtensionHarness(): ExtensionHarness {
	const providers: Provider[] = [];
	return {
		providers,
		pi: {
			registerProvider(provider: Provider) {
				providers.push(provider);
			},
			on() {},
			setThinkingLevel() {},
		} as unknown as ExtensionAPI,
	};
}

function createRegistryPi(registry: ModelRegistry): ExtensionAPI {
	return {
		registerProvider(provider: Provider) {
			registry.registerProvider(provider);
		},
		on() {},
		setThinkingLevel() {},
	} as unknown as ExtensionAPI;
}

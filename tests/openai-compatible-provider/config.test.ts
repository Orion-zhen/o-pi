import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AuthStorage, ModelRegistry, type ExtensionAPI, type ProviderConfig as PiProviderConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import openAICompatibleProvider from "../../agent/extensions/openai-compatible-provider.js";
import {
	applyRuntimePayloadConfig,
	defaultModelsCachePath,
	loadModelsDiscoveryCache,
	loadModelsJsoncConfig,
	normalizeModelsJsoncConfig,
	redact_api_key,
	registerOpenAICompatibleProviders,
	resolveAutoModelsJsoncConfig,
	resolveCachedModelsJsoncConfig,
} from "../../src/openai-compatible-provider/index.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let dir: string;
const temp = useTempDir("o-pi-models-jsonc-");
preserveEnv("PI_CODING_AGENT_DIR");
preserveEnv("PI_OFFLINE");

beforeEach(() => {
	dir = temp.path;
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("openai-compatible-provider config", () => {
	it("扩展启动只注册手写与缓存模型，手动刷新后更新 registry 和私有缓存", async () => {
		process.env.PI_CODING_AGENT_DIR = dir;
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{ "data": [{ "id": "discovered" }] }'));
		await writeFile(
			path.join(dir, "models.jsonc"),
			'{ "providers": { "local": { "base_url": "http://127.0.0.1:8000/v1", "api_key": "EMPTY", "models": ["model"] } } }',
			{ mode: 0o600 },
		);
		const harness = createExtensionHarness();

		await openAICompatibleProvider(harness.pi);

		expect(harness.providerCalls).toHaveLength(1);
		expect(harness.providerCalls[0]?.name).toBe("local");
		expect(harness.providerCalls[0]?.config.models?.map((model) => model.id)).toEqual(["model"]);
		expect(fetch).not.toHaveBeenCalled();

		await harness.runCommand("refresh-models");

		expect(harness.providerCalls).toHaveLength(2);
		expect(harness.providerCalls[1]?.config.models?.map((model) => model.id)).toEqual(["model", "discovered"]);
		expect(fetch).toHaveBeenCalledOnce();
		const cachePath = defaultModelsCachePath();
		expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({
			version: 1,
			providers: { local: { models: [{ model: "discovered" }] } },
		});
		expect((await stat(cachePath)).mode & 0o777).toBe(0o600);

		const restart = createExtensionHarness();
		await openAICompatibleProvider(restart.pi);
		expect(restart.providerCalls[0]?.config.models?.map((model) => model.id)).toEqual(["model", "discovered"]);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("session_start 后并发刷新所有 provider，手动命令复用进行中的请求", async () => {
		process.env.PI_CODING_AGENT_DIR = dir;
		await writeFile(
			path.join(dir, "models.jsonc"),
			'{ "providers": { "one": { "base_url": "https://one.test/v1", "api_key": "EMPTY" }, "two": { "base_url": "https://two.test/v1", "api_key": "EMPTY" } } }',
			{ mode: 0o600 },
		);
		let active = 0;
		let maxActive = 0;
		let started = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			active++;
			started++;
			maxActive = Math.max(maxActive, active);
			if (started === 2) release?.();
			await gate;
			active--;
			const host = new URL(String(input)).hostname;
			return new Response(JSON.stringify({ data: [{ id: `${host}-model` }] }));
		});
		const harness = createExtensionHarness();
		await openAICompatibleProvider(harness.pi);

		expect(harness.providerCalls).toHaveLength(0);
		await harness.emit("session_start");
		await harness.runCommand("refresh-models");

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(maxActive).toBe(2);
		expect(harness.providerCalls.map((call) => call.name)).toEqual(["one", "two"]);
		expect(harness.notifications.some((item) => item.message.includes("Reopen /model"))).toBe(false);
		expect(harness.notifications.at(-1)?.message).toBe("Model refresh complete: 2 updated, 0 failed.");
	});

	it("部分刷新失败时保留该 provider 的旧缓存", async () => {
		process.env.PI_CODING_AGENT_DIR = dir;
		await writeFile(
			path.join(dir, "models.jsonc"),
			'{ "providers": { "one": { "base_url": "https://one.test/v1", "api_key": "EMPTY" }, "two": { "base_url": "https://two.test/v1", "api_key": "EMPTY" } } }',
			{ mode: 0o600 },
		);
		let round = 1;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const host = new URL(String(input)).hostname;
			if (round === 2 && host === "two.test") throw new Error("unreachable");
			return new Response(JSON.stringify({ data: [{ id: `${host}-model-${round}` }] }));
		});
		const harness = createExtensionHarness();
		await openAICompatibleProvider(harness.pi);
		await harness.runCommand("refresh-models");
		round = 2;
		await harness.runCommand("refresh-models");

		const latest = harness.providerCalls.slice(-2);
		expect(latest.find((call) => call.name === "one")?.config.models?.map((model) => model.id)).toEqual(["one.test-model-2"]);
		expect(latest.find((call) => call.name === "two")?.config.models?.map((model) => model.id)).toEqual(["two.test-model-1"]);
		expect(harness.notifications.at(-1)).toMatchObject({ type: "warning" });
	});

	it("离线模式不启动自动或手动发现", async () => {
		process.env.PI_CODING_AGENT_DIR = dir;
		process.env.PI_OFFLINE = "true";
		await writeFile(
			path.join(dir, "models.jsonc"),
			'{ "providers": { "local": { "base_url": "http://local.test/v1", "api_key": "EMPTY", "models": ["model"] } } }',
			{ mode: 0o600 },
		);
		const fetch = vi.spyOn(globalThis, "fetch");
		const harness = createExtensionHarness();
		await openAICompatibleProvider(harness.pi);
		await harness.emit("session_start");
		await harness.runCommand("refresh-models");

		expect(fetch).not.toHaveBeenCalled();
		expect(harness.notifications.at(-1)?.message).toContain("offline mode");
	});

	it("损坏缓存按空缓存处理", async () => {
		process.env.PI_CODING_AGENT_DIR = dir;
		const cachePath = defaultModelsCachePath();
		await mkdir(path.dirname(cachePath), { recursive: true });
		await writeFile(cachePath, "not-json");
		expect(await loadModelsDiscoveryCache(cachePath)).toEqual({ version: 1, providers: {} });
	});

	it("不复用其他 endpoint 的缓存，也不接受缓存中的请求期配置", async () => {
		const config = await loadConfigFromText(`{
			"providers": { "gateway": { "base_url": "https://new.test/v1", "api_key": "EMPTY" } }
		}`);
		const stale = {
			version: 1 as const,
			providers: { gateway: { source: "sha256:stale", models: [{ model: "old" }] } },
		};
		expect(resolveCachedModelsJsoncConfig(config, stale).providers).toEqual({});

		process.env.PI_CODING_AGENT_DIR = dir;
		const cachePath = defaultModelsCachePath();
		await mkdir(path.dirname(cachePath), { recursive: true });
		await writeFile(cachePath, JSON.stringify({
			version: 1,
			providers: { gateway: { source: "sha256:value", models: [{ model: "unsafe", defaults: { temperature: 2 } }] } },
		}));
		expect((await loadModelsDiscoveryCache(cachePath)).providers).toEqual({});
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

	it("模型发现超时覆盖响应 body 读取", async () => {
		vi.useFakeTimers();
		const config = await loadConfigFromText(`{
			"providers": {
				"gateway": { "base_url": "https://gateway.example.com/v1", "api_key": "EMPTY", "models": "auto" }
			}
		}`);
		const promise = resolveAutoModelsJsoncConfig(config, path.join(dir, "models.jsonc"), {
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

	it("Chat chat_template_enabled 不需要 map，并把所有非 off 等级交给 Pi 的布尔变量", async () => {
		const [provider] = await normalizeFromText(`{
			"providers": {
				"local": {
					"base_url": "http://127.0.0.1:8000/v1",
					"api_key": "EMPTY",
					"api": "chat",
					"compat": "local",
					"thinking": "chat_template_enabled",
					"models": [{ "model": "m", "thinking_level": "high" }]
				}
			}
		}`);
		expect(provider?.config.models?.[0]).toMatchObject({
			reasoning: true,
			compat: {
				thinkingFormat: "chat-template",
				chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
			},
		});
		expect(provider?.config.models?.[0]?.thinkingLevelMap).toBeUndefined();
	});

	it("thinking_level 使用 Pi 模型能力并保留 off 模型的可切换 reasoning", async () => {
		const [provider] = await normalizeFromText(`{
			"providers": {
				"gateway": {
					"base_url": "https://example.test/v1",
					"api_key": "EMPTY",
					"thinking": "openai",
					"models": [
						{ "model": "reasoning-model", "thinking_level": "high" },
						{ "model": "off-model", "thinking_level": "off" },
						{ "model": "plain-model" }
					]
				}
			}
		}`);
		expect(provider?.config.models?.[0]).toMatchObject({ id: "reasoning-model", reasoning: true });
		expect(provider?.config.models?.[1]).toMatchObject({ id: "off-model", reasoning: true });
		expect(provider?.config.models?.[2]).toMatchObject({ id: "plain-model", reasoning: false });
		expect(provider?.runtimeModels.get("reasoning-model")?.defaultThinkingLevel).toBe("high");
		expect(provider?.runtimeModels.get("off-model")?.defaultThinkingLevel).toBe("off");
		expect(provider?.config.models?.[0]?.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
		});
	});

	it("只在用户选择模型时应用默认 thinking_level，不覆盖恢复值或每轮用户选择", async () => {
		const providers = await normalizeFromText(`{
			"providers": {
				"gateway": {
					"base_url": "https://example.test/v1",
					"api_key": "EMPTY",
					"thinking": "openai",
					"models": [{ "model": "m", "thinking_level": "minimal" }]
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
		handlers.get("session_start")?.({ reason: "new" }, { model });
		handlers.get("before_agent_start")?.({}, { model });
		handlers.get("model_select")?.({ model, source: "restore" });
		handlers.get("model_select")?.({ model, source: "set" });

		expect(thinkingLevels).toEqual(["minimal"]);
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

	it.each([
		["openrouter", "high", { reasoning: { effort: "high" } }],
		["deepseek", "high", { thinking: { type: "enabled" } }],
		["together", "off", { reasoning: { enabled: false } }],
		["zai", "high", { thinking: { type: "enabled", clear_thinking: false } }],
		["qwen", "off", { enable_thinking: false }],
		["qwen_chat_template", "high", { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } }],
		["chat_template_enabled", "medium", { chat_template_kwargs: { enable_thinking: true } }],
		["chat_template_enabled", "off", { chat_template_kwargs: { enable_thinking: false } }],
		["chat_template_effort", "high", { chat_template_kwargs: { reasoning_effort: "high" } }],
		["string_thinking", "off", { thinking: "none" }],
	] as const)("Responses API 将 %s thinking preset 编码到 payload", async (thinking, level, expected) => {
		const [provider] = await normalizeFromText(`{
			"providers": {
				"gateway": {
					"base_url": "https://gateway.example.com/v1",
					"api_key": "$RESPONSES_GATEWAY_API_KEY",
					"api": "responses",
					"thinking": "${thinking}",
					"models": [{ "model": "m", "thinking_level": "${level}" }]
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

	it("Responses chat_template_effort 使用 Pi thinking_level_map 的上游值", async () => {
		const [provider] = await normalizeFromText(`{
			"providers": {
				"thor": {
					"base_url": "http://thor:11451/v1",
					"api_key": "EMPTY",
					"api": "responses",
					"thinking": "chat_template_effort",
					"models": [{
						"model": "hy3",
						"thinking_level": "xhigh",
						"thinking_level_map": { "off": "disabled", "xhigh": "max" }
					}]
				}
			}
		}`);
		const model = provider?.config.models?.[0];
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
					"base_url": "https://standard.example.com/v1",
					"api_key": "EMPTY",
					"api": "responses",
					"thinking": "openai",
					"models": [{ "model": "m", "thinking_level": "high" }]
				},
				"fixed": {
					"base_url": "https://fixed.example.com/v1",
					"api_key": "EMPTY",
					"api": "responses",
					"thinking": "none",
					"models": [{ "model": "m", "thinking_level": "high" }]
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

	it("Responses 使用 Pi map 为 ant_ling 和支持 effort 的 deepseek 生成 provider 值", async () => {
		const providers = await normalizeFromText(`{
			"providers": {
				"ant": {
					"base_url": "https://ant.example.com/v1",
					"api_key": "EMPTY",
					"api": "responses",
					"thinking": "ant_ling",
					"models": [{ "model": "m", "thinking_level": "high", "thinking_level_map": { "high": "max" } }]
				},
				"deep": {
					"base_url": "https://deep.example.com/v1",
					"api_key": "EMPTY",
					"api": "responses",
					"thinking": "deepseek",
					"models": [{
						"model": "m",
						"thinking_level": "high",
						"thinking_level_map": { "high": "max" },
						"advanced": { "compat": { "supportsReasoningEffort": true } }
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
		).rejects.toThrow("use thinking_level instead");

		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "base_url": "http://127.0.0.1:8000/v1", "api_key": "EMPTY", "models": [{ "model": "m", "reasoning_effort": "high" }] } }
			}`),
		).rejects.toThrow("use thinking_level instead");

		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "base_url": "http://127.0.0.1:8000/v1", "api_key": "EMPTY", "thinking": "unknown", "models": ["m"] } }
			}`),
		).rejects.toThrow('unknown thinking preset "unknown"');

		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "base_url": "http://127.0.0.1:8000/v1", "api_key": "EMPTY", "models": [{ "model": "m", "thinking_level": "max" }] } }
			}`),
		).rejects.toThrow('thinking_level "max" is not supported');

		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "base_url": "http://127.0.0.1:8000/v1", "api_key": "EMPTY", "models": [{ "model": "m", "thinking_level_map": { "max": "max" } }] } }
			}`),
		).rejects.toThrow('thinking_level_map contains unknown Pi thinking level "max"');

		await expect(
			normalizeFromText(`{
				"providers": { "vllm": { "base_url": "http://127.0.0.1:8000/v1", "api_key": "EMPTY", "models": [{ "model": "m", "thinking_level": "high", "thinking_level_map": { "high": null } }] } }
			}`),
		).rejects.toThrow('thinking_level "high" is not supported');
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

interface ExtensionHarness {
	pi: ExtensionAPI;
	providerCalls: Array<{ name: string; config: PiProviderConfig }>;
	notifications: Array<{ message: string; type: string | undefined }>;
	emit(name: string): Promise<void>;
	runCommand(name: string): Promise<void>;
}

function createExtensionHarness(): ExtensionHarness {
	type Handler = (event: unknown, ctx: TestExtensionContext) => unknown;
	type CommandHandler = (args: string, ctx: TestExtensionContext) => unknown;
	const providerCalls: Array<{ name: string; config: PiProviderConfig }> = [];
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();
	const ctx: TestExtensionContext = {
		model: undefined,
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
		},
	};
	const pi = {
		registerProvider(name: string, config: PiProviderConfig) {
			providerCalls.push({ name, config });
		},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
		on(name: string, handler: Handler) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		setThinkingLevel() {},
	} as unknown as ExtensionAPI;
	return {
		pi,
		providerCalls,
		notifications,
		async emit(name) {
			for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
		},
		async runCommand(name) {
			const handler = commands.get(name);
			if (!handler) throw new Error(`command ${name} is not registered`);
			await handler("", ctx);
		},
	};
}

interface TestExtensionContext {
	model: undefined;
	ui: {
		notify(message: string, type?: string): void;
	};
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

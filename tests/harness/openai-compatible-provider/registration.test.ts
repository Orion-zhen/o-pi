import { writeFile } from "node:fs/promises";
import path from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, type Provider } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import openAICompatibleProvider from "../../../src/harness/extensions/openai-compatible-provider.ts";
import { loadModelsConfig } from "../../../src/harness/openai-compatible-provider/config.ts";
import { registerOpenAICompatibleProviders } from "../../../src/harness/openai-compatible-provider/register.ts";
import { createExtensionHarness, createRegistryPi, loadConfigFromText, providerConfig, registerProvider } from "./fixtures.ts";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.ts";

const temp = useOpenAICompatibleProviderTestSetup();

describe("openai-compatible-provider registration", () => {
	it("仓库示例配置与当前 schema 同步", async () => {
		const config = await loadModelsConfig(path.resolve("agent/models.example.jsonc"));
		if (!config) throw new Error("example config missing");
		expect(config.providers["llama-cpp"]).toBeUndefined();
		expect(config.providers["llama-swap"]?.thinkingPreset).toBe("model-suffix");
		expect(config.providers["responses-demo"]?.api).toBe("openai-responses");
	});

	it("扩展只注册完整原生 Provider，启动阶段不自行联网", async () => {
		process.env.PI_CODING_AGENT_DIR = temp.path;
		const fetch = vi.spyOn(globalThis, "fetch");
		await writeFile(
			path.join(temp.path, "models.json"),
			'{ "providers": { "local": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "fixture", "api": "openai-completions", "discoverModels": true, "models": [{"id":"manual"}] } } }',
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

	it.each([undefined, false])("普通静态配置不因 discoverModels=%s 注册扩展 provider", async (discoverModels) => {
		const config = await loadConfigFromText(temp.path, JSON.stringify({ providers: {
			local: providerConfig({ discoverModels }, "local"),
		} }));
		const harness = createExtensionHarness();
		registerOpenAICompatibleProviders(harness.pi, config, "models.json");
		expect(harness.providers).toEqual([]);
	});

	it("仅设置默认思考等级时保留内置 provider，不要求 baseUrl 或 OpenAI API", async () => {
		const runtime = await ModelRuntime.create({
			modelsPath: null, credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false, refreshOnCreate: false,
		});
		const native = runtime.getProvider("anthropic");
		const model = native?.getModels().find((entry) => entry.reasoning);
		if (!native || !model) throw new Error("native reasoning model missing");
		const config = await loadConfigFromText(temp.path, JSON.stringify({ providers: {
			anthropic: { discoverModels: false, modelOverrides: { [model.id]: { defaultThinkingLevel: "high" } } },
		} }));
		const select = vi.fn<(event: unknown) => void>();
		const levels: string[] = [];
		const register = vi.fn((provider: Provider) => runtime.registerNativeProvider(provider));
		const pi = {
			registerProvider(provider: Provider) { register(provider); },
			on(_name: string, handler: (event: unknown) => void) { select.mockImplementation(handler); },
			setThinkingLevel(level: string) { levels.push(level); },
		};
		registerOpenAICompatibleProviders(pi as ExtensionAPI, config, "models.json");
		expect(register).not.toHaveBeenCalled();
		expect(runtime.getProvider("anthropic")).toBe(native);
		select({ model, source: "restore" });
		expect(levels).toEqual([]);
		select({ model, source: "set" });
		expect(levels).toEqual(["high"]);
	});

	it("不存在 models.json 时不产生 provider 注册输入", async () => {
		expect(await loadModelsConfig(path.join(temp.path, "models.json"))).toBeUndefined();
	});

	it("接受带 UTF-8 BOM 的 models.json", async () => {
		const configPath = path.join(temp.path, "bom-models.json");
		await writeFile(configPath, '\uFEFF{ "providers": { "local": { "baseUrl": "http://127.0.0.1:8000/v1", "api": "openai-completions", "discoverModels": true, "models": [{"id":"model"}] } } }');

		await expect(loadModelsConfig(configPath)).resolves.toMatchObject({
			providers: { local: { models: [{ id: "model" }] } },
		});
	});

	it("配置文件读取失败时转换为配置错误", async () => {
		await expect(loadModelsConfig(temp.path)).rejects.toThrow();
	});

	it("同名 provider 注册到 Pi 时完全替换内置 provider 模型", async () => {
		const config = await loadConfigFromText(temp.path, JSON.stringify({ providers: {
			opencode: providerConfig({
				discoverModels: true,
				name: "Private OpenCode",
				baseUrl: "https://private-opencode.example.com/v1",
				models: [{ id: "private-opencode-model" }],
			}, "opencode"),
		} }));
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: path.join(temp.path, "models.json"),
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});
		const registry = new ModelRegistry(runtime);
		const builtInModelIds = registry.getAll().filter((model) => model.provider === "opencode").map((model) => model.id);
		expect(builtInModelIds.length).toBeGreaterThan(0);
		expect(builtInModelIds).not.toEqual(["private-opencode-model"]);

		registerOpenAICompatibleProviders(createRegistryPi(registry), config, path.join(temp.path, "models.json"));

		const models = registry.getAll().filter((model) => model.provider === "opencode");
		expect(models.map((model) => model.id)).toEqual(["private-opencode-model"]);
		expect(models[0]).toMatchObject({
			name: "private-opencode-model",
			baseUrl: "https://private-opencode.example.com/v1",
			api: "openai-completions",
		});
		expect(registry.getProviderDisplayName("opencode")).toBe("Private OpenCode");
	});

	it("ModelRuntime 请求保留已存储密钥和调用方请求头优先级", async () => {
		const config = await loadConfigFromText(temp.path, JSON.stringify({ providers: {
			gateway: providerConfig({
				dropParams: ["store"],
				headers: { "X-Value": "provider" },
				models: [{ id: "m", headers: { "X-Value": "model" } }],
			}),
		} }));
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("gateway", async () => ({ type: "api_key", key: "sk-stored" }));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: path.join(temp.path, "models.json"), modelsStore: new InMemoryModelsStore(), allowModelNetwork: false });
		const registry = new ModelRegistry(runtime);
		registerOpenAICompatibleProviders(createRegistryPi(registry), config, "models.json");
		const model = registry.find("gateway", "m");
		if (!model) throw new Error("registered model missing");
		let headers: Headers | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			headers = new Headers(init?.headers);
			return new Response('{"error":"stop"}', { status: 400 });
		});
		for await (const _event of runtime.streamSimple(model, {
			messages: [{ role: "user", content: "test", timestamp: 0 }],
		}, { headers: { "x-value": "provider" } })) {}
		expect(headers?.get("Authorization")).toBe("Bearer sk-stored");
		expect(headers?.get("X-Value")).toBe("provider");
	});

	it.each([
		[{}, "minimal"],
		[{ m: { name: "Renamed" } }, "minimal"],
		[{ m: { defaultThinkingLevel: "high" } }, "high"],
	] as const)("默认思考等级遵循模型覆盖顺序，仅在用户选择模型时应用 %#", async (modelOverrides, expected) => {
		const config = await loadConfigFromText(temp.path, JSON.stringify({ providers: {
			gateway: providerConfig({
				models: [{ id: "m", reasoning: true, defaultThinkingLevel: "minimal" }],
				modelOverrides,
			}),
		} }));
		const handlers = new Map<string, (event: unknown) => void>();
		const providers: Provider[] = [];
		const thinkingLevels: string[] = [];
		const pi = {
			registerProvider(provider: Provider) { providers.push(provider); },
			on(name: string, handler: (event: unknown) => void) {
				handlers.set(name, handler);
			},
			setThinkingLevel(level: string) {
				thinkingLevels.push(level);
			},
		};
		registerOpenAICompatibleProviders(pi as ExtensionAPI, config, path.join(temp.path, "models.json"));

		expect([...handlers.keys()]).toEqual(["model_select"]);
		expect(providers).toEqual([]);
		const { provider } = await registerProvider(config, temp.path, "gateway");
		const model = provider.getModels()[0];
		const select = handlers.get("model_select");
		if (!model || !select) throw new Error("model selection was not registered");
		select({ model, source: "restore" });
		expect(thinkingLevels).toEqual([]);
		select({ model, source: "set" });

		expect(thinkingLevels).toEqual([expected]);
	});
});

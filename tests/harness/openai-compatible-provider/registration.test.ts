import { writeFile } from "node:fs/promises";
import path from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, type Provider } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import openAICompatibleProvider from "../../../src/harness/extensions/openai-compatible-provider.ts";
import { loadModelsJsoncConfig } from "../../../src/harness/openai-compatible-provider/config.ts";
import { registerOpenAICompatibleProviders } from "../../../src/harness/openai-compatible-provider/register.ts";
import { createExtensionHarness, createRegistryPi, loadConfigFromText, loadProvider, providerConfig } from "./fixtures.ts";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.ts";

const temp = useOpenAICompatibleProviderTestSetup();

describe("openai-compatible-provider registration", () => {
	it("将已知缓存寿命透传给原生模型，不为未配置模型猜测寿命", async () => {
		const provider = await loadProvider(temp.path, { models: [
			{ id: "warm", promptCache: { short: 300, long: 3600 } }, { id: "unknown" },
		] });
		expect(provider.getModels()[0]?.promptCache).toEqual({ short: 300, long: 3600 });
		expect(provider.getModels()[1]).not.toHaveProperty("promptCache");
	});

	it.each([{ short: 0 }, { long: -1 }, { short: "300" }, { daily: 86400 }])("拒绝无效缓存寿命 %j", async (promptCache) => {
		await expect(loadProvider(temp.path, { models: [{ id: "m", promptCache }] })).rejects.toThrow("Invalid");
	});

	it("仓库示例配置与当前 schema 同步", async () => {
		const config = await loadModelsJsoncConfig(path.resolve("agent/models.example.jsonc"));
		expect(config?.providers["llama-cpp"]?.api).toBe("openai-completions");
		expect(config?.providers["llama-swap"]?.thinkingPreset).toBe("model-suffix");
		expect(config?.providers["responses-demo"]?.api).toBe("openai-responses");
	});

	it("扩展只注册完整原生 Provider，启动阶段不自行联网", async () => {
		process.env.PI_CODING_AGENT_DIR = temp.path;
		const fetch = vi.spyOn(globalThis, "fetch");
		await writeFile(
			path.join(temp.path, "models.jsonc"),
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

	it("不存在 models.jsonc 时不产生 provider 注册输入", async () => {
		expect(await loadModelsJsoncConfig(path.join(temp.path, "missing.jsonc"))).toBeUndefined();
	});

	it("接受带 UTF-8 BOM 的 models.jsonc", async () => {
		const configPath = path.join(temp.path, "bom-models.jsonc");
		await writeFile(configPath, '\uFEFF{ "providers": { "local": { "baseUrl": "http://127.0.0.1:8000/v1", "models": ["model"] } } }');

		await expect(loadModelsJsoncConfig(configPath)).resolves.toMatchObject({
			providers: { local: { models: ["model"] } },
		});
	});

	it("配置文件读取失败时转换为配置错误", async () => {
		await expect(loadModelsJsoncConfig(temp.path)).rejects.toThrow(`Invalid ${temp.path}:\nfile cannot be read`);
	});

	it("最小配置注册为完整原生 provider，并把字符串模型归一化为同名 model id", async () => {
		const config = await loadConfigFromText(temp.path, JSON.stringify({ providers: {
			vllm: providerConfig({
				name: "Local vLLM",
				baseUrl: "http://127.0.0.1:8000/v1",
				api: "openai-completions",
				models: ["Qwen/Qwen3-Coder-480B-A35B-Instruct"],
			}, "vllm"),
		} }));
		const harness = createExtensionHarness();
		registerOpenAICompatibleProviders(harness.pi, config, path.join(temp.path, "models.jsonc"));
		const [provider] = harness.providers;

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
		const config = await loadConfigFromText(temp.path, JSON.stringify({ providers: {
			opencode: providerConfig({
				name: "Private OpenCode",
				baseUrl: "https://private-opencode.example.com/v1",
				models: ["private-opencode-model"],
			}, "opencode"),
		} }));
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

		registerOpenAICompatibleProviders(createRegistryPi(registry), config, path.join(temp.path, "models.jsonc"));

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
				headers: { "X-Value": "provider" },
				models: [{ id: "m", headers: { "X-Value": "model" } }],
			}),
		} }));
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("gateway", async () => ({ type: "api_key", key: "sk-stored" }));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false });
		const registry = new ModelRegistry(runtime);
		registerOpenAICompatibleProviders(createRegistryPi(registry), config, "models.jsonc");
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

	it("模型目录刷新由 ModelRuntime 更新快照且不重复注册 provider", async () => {
		const config = await loadConfigFromText(temp.path, JSON.stringify({ providers: {
			local: providerConfig({ baseUrl: "http://127.0.0.1:8000/v1", models: undefined }, "local"),
		} }));
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response('{ "data": [{ "id": "dynamic-model" }] }'),
		);
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
		});
		const registry = new ModelRegistry(runtime);
		const registerProvider = vi.spyOn(registry, "registerProvider");

		registerOpenAICompatibleProviders(
			createRegistryPi(registry),
			config,
			path.join(temp.path, "models.jsonc"),
		);
		await registry.refresh({ allowNetwork: true, providers: ["local"] });

		expect(registerProvider).toHaveBeenCalledOnce();
		expect(registerProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "local" }));
		expect(fetch).toHaveBeenCalledOnce();
		expect(registry.find("local", "dynamic-model")).toMatchObject({
			id: "dynamic-model",
			provider: "local",
			baseUrl: "http://127.0.0.1:8000/v1",
		});
	});

	it("只在用户选择模型时应用 defaultThinkingLevel，不覆盖恢复值或每轮用户选择", async () => {
		const config = await loadConfigFromText(temp.path, JSON.stringify({ providers: {
			gateway: providerConfig({
				thinkingPreset: "openai",
				models: [{ id: "m", defaultThinkingLevel: "minimal" }],
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
		registerOpenAICompatibleProviders(pi as ExtensionAPI, config, path.join(temp.path, "models.jsonc"));

		expect([...handlers.keys()]).toEqual(["model_select"]);
		const model = providers[0]?.getModels()[0];
		const select = handlers.get("model_select");
		if (!model || !select) throw new Error("model selection was not registered");
		select({ model, source: "restore" });
		expect(thinkingLevels).toEqual([]);
		select({ model, source: "set" });

		expect(thinkingLevels).toEqual(["minimal"]);
	});
});

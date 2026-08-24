import { writeFile } from "node:fs/promises";
import path from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createEventBus, ModelRegistry, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import openAICompatibleProvider from "../../agent/extensions/openai-compatible-provider.js";
import { loadModelsJsoncConfig } from "../../src/openai-compatible-provider/config.js";
import { registerOpenAICompatibleProviders } from "../../src/openai-compatible-provider/register.js";
import { createExtensionHarness, createRegistryPi, loadConfigFromText, providerConfig } from "./fixtures.js";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.js";

const temp = useOpenAICompatibleProviderTestSetup();

describe("openai-compatible-provider registration", () => {
	it("仓库示例配置与当前 schema 同步", async () => {
		const config = await loadModelsJsoncConfig(path.resolve("agent/models.example.jsonc"));
		expect(config?.providers["llama-cpp"]?.api).toBe("openai-completions");
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
		const [provider] = registerOpenAICompatibleProviders(harness.pi, config, path.join(temp.path, "models.jsonc"));

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

		const [provider] = registerOpenAICompatibleProviders(
			createRegistryPi(registry),
			config,
			path.join(temp.path, "models.jsonc"),
		);
		await registry.refresh({ allowNetwork: true, providers: ["local"] });

		expect(registerProvider).toHaveBeenCalledOnce();
		expect(registerProvider).toHaveBeenCalledWith(provider);
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
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => void>();
		const thinkingLevels: string[] = [];
		const pi = {
			events: createEventBus(),
			registerProvider() {},
			on(name: string, handler: (event: unknown, ctx?: unknown) => void) {
				handlers.set(name, handler);
			},
			setThinkingLevel(level: string) {
				thinkingLevels.push(level);
			},
		};
		registerOpenAICompatibleProviders(pi as unknown as ExtensionAPI, config, path.join(temp.path, "models.jsonc"));

		const model = { provider: "gateway", id: "m" };
		handlers.get("session_start")?.({ reason: "new" }, { model });
		handlers.get("before_agent_start")?.({}, { model });
		handlers.get("model_select")?.({ model, source: "restore" });
		handlers.get("model_select")?.({ model, source: "set" });

		expect(thinkingLevels).toEqual(["minimal"]);
	});
});

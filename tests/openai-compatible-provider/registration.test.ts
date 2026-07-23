import { writeFile } from "node:fs/promises";
import path from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createEventBus, ModelRegistry, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import openAICompatibleProvider from "../../agent/extensions/openai-compatible-provider.js";
import { loadModelsJsoncConfig, registerOpenAICompatibleProviders } from "../../src/openai-compatible-provider/index.js";
import { createExtensionHarness, createRegistryPi, loadConfigFromText } from "./fixtures.js";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.js";

const temp = useOpenAICompatibleProviderTestSetup();

describe("openai-compatible-provider registration", () => {
	it("仓库示例配置与当前 schema 同步", async () => {
		const config = await loadModelsJsoncConfig(path.resolve("agent/models.jsonc.example"));
		expect(config?.providers["llama-cpp"]?.api).toBe("openai-responses");
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

	it("最小配置注册为完整原生 provider，并把字符串模型归一化为同名 model id", async () => {
		const config = await loadConfigFromText(temp.path, `{
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
		const config = await loadConfigFromText(temp.path, `{
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

	it("只在用户选择模型时应用 defaultThinkingLevel，不覆盖恢复值或每轮用户选择", async () => {
		const config = await loadConfigFromText(temp.path, `{
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

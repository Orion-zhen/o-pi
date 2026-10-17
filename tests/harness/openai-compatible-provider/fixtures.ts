import { writeFile } from "node:fs/promises";
import path from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, type Context, type Provider, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { loadModelsConfig } from "../../../src/harness/openai-compatible-provider/config.ts";
import { registerOpenAICompatibleProviders } from "../../../src/harness/openai-compatible-provider/register.ts";
import type { ModelsConfig } from "../../../src/harness/openai-compatible-provider/schema.ts";

export function providerConfig(overrides: Record<string, unknown> = {}, providerId = "gateway"): Record<string, unknown> {
	return {
		baseUrl: `https://${providerId}.example.test/v1`, api: "openai-completions",
		apiKey: "fixture", models: [{ id: "m" }], ...overrides,
	};
}

export async function loadProvider(dir: string, overrides: Record<string, unknown> = {}, providerId = "gateway", modelsStore = new InMemoryModelsStore()) {
	const config = await loadConfigFromText(dir, JSON.stringify({ providers: { [providerId]: providerConfig(overrides, providerId) } }));
	return registerProvider(config, dir, providerId, modelsStore);
}

/** 只模拟 HTTP，认证、模型配置和请求构建均经过 SDK。 */
export async function capturePayload(
	{ provider, runtime }: { provider: Provider; runtime: ModelRuntime },
	options: SimpleStreamOptions = {},
	{ modelId = "m", context = { messages: [{ role: "user", content: "test", timestamp: 0 }] } }:
	{ modelId?: string; context?: Context } = {},
): Promise<unknown> {
	const model = provider.getModels().find((entry) => entry.id === modelId);
	if (!model) throw new Error(`model ${modelId} missing`);
	let payload: unknown;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		payload = JSON.parse(String(init?.body));
		return new Response('{"error":"stop after payload"}', { status: 400 });
	});
	for await (const _event of runtime.streamSimple(model, context, options)) {}
	if (payload === undefined) throw new Error("request was not sent");
	return payload;
}

export async function loadConfigFromText(dir: string, text: string): Promise<ModelsConfig> {
	const file = path.join(dir, "models.json");
	await writeFile(file, text);
	const config = await loadModelsConfig(file);
	if (!config) throw new Error("config unexpectedly missing");
	return config;
}

interface ExtensionHarness { pi: ExtensionAPI; providers: Provider[] }

export async function registerProvider(config: ModelsConfig, dir: string, providerId: string, modelsStore = new InMemoryModelsStore()) {
	const harness = createExtensionHarness();
	registerOpenAICompatibleProviders(harness.pi, config, path.join(dir, "models.json"));
	const runtime = await ModelRuntime.create({
		modelsPath: path.join(dir, "models.json"), credentials: new InMemoryCredentialStore(), modelsStore,
		allowModelNetwork: false, refreshOnCreate: false,
	});
	for (const provider of harness.providers) runtime.registerNativeProvider(provider);
	const error = runtime.getError();
	if (error) throw new Error(error);
	const provider = runtime.getProvider(providerId);
	if (!provider) throw new Error("provider not registered");
	return { provider, harness, runtime };
}

export function createExtensionHarness(): ExtensionHarness {
	const providers: Provider[] = [];
	return {
		providers,
		pi: { registerProvider(provider: Provider) { providers.push(provider); }, on(_event: string, _handler: unknown) {}, setThinkingLevel(_level: string) {} } as ExtensionAPI,
	};
}

export function createRegistryPi(registry: ModelRegistry): ExtensionAPI {
	return { registerProvider(provider: Provider) { registry.registerProvider(provider); }, on(_event: string, _handler: unknown) {}, setThinkingLevel(_level: string) {} } as ExtensionAPI;
}

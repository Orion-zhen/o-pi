import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { Context, Provider, ProviderStreamOptions, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { vi } from "vitest";
import type { ModelRegistry, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadModelsJsoncConfig } from "../../src/openai-compatible-provider/config.js";
import { registerOpenAICompatibleProviders } from "../../src/openai-compatible-provider/register.js";
import type { ModelsJsoncConfig } from "../../src/openai-compatible-provider/schema.js";

export function providerConfig(
	overrides: Record<string, unknown> = {},
	providerId = "gateway",
): Record<string, unknown> {
	return {
		baseUrl: `https://${providerId}.example.test/v1`,
		apiKey: "EMPTY",
		models: ["m"],
		...overrides,
	};
}

export function providerConfigText(
	overrides: Record<string, unknown> = {},
	providerId = "gateway",
): string {
	return JSON.stringify({ providers: { [providerId]: providerConfig(overrides, providerId) } });
}

export async function loadProvider(
	dir: string,
	overrides: Record<string, unknown> = {},
	providerId = "gateway",
): Promise<Provider> {
	const config = await loadConfigFromText(dir, providerConfigText(overrides, providerId));
	return registerProvider(config, dir).provider;
}

/** 只模拟 HTTP 边界，经过原生 Provider 的完整请求构建流程。 */
export async function capturePayload(
	provider: Provider,
	options: ProviderStreamOptions & SimpleStreamOptions = {},
	{
		modelId = "m", simple = false,
		context = { messages: [{ role: "user", content: "test", timestamp: 0 }] },
	}: { modelId?: string; simple?: boolean; context?: Context } = {},
): Promise<unknown> {
	const model = provider.getModels().find((entry) => entry.id === modelId);
	if (!model) throw new Error(`model ${modelId} missing`);
	let payload: unknown;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		payload = JSON.parse(String(init?.body));
		return new Response('{"error":"stop after payload"}', { status: 400 });
	});
	const stream = simple
		? provider.streamSimple(model, context, { apiKey: "sk-test", ...options })
		: provider.stream(model, context, { apiKey: "sk-test", ...options });
	for await (const _event of stream) {}
	if (payload === undefined) throw new Error("request was not sent");
	return payload;
}

export async function loadConfigFromText(dir: string, text: string): Promise<ModelsJsoncConfig> {
	const file = path.join(dir, "models.jsonc");
	await writeFile(file, text);
	const config = await loadModelsJsoncConfig(file);
	if (!config) throw new Error("config unexpectedly missing");
	return config;
}

interface ExtensionHarness {
	pi: ExtensionAPI;
	providers: Provider[];
}

export function registerProvider(
	config: ModelsJsoncConfig,
	dir: string,
): { provider: Provider; harness: ExtensionHarness } {
	const harness = createExtensionHarness();
	registerOpenAICompatibleProviders(harness.pi, config, path.join(dir, "models.jsonc"));
	const [provider] = harness.providers;
	if (!provider) throw new Error("provider was not registered");
	return { provider, harness };
}

export function createExtensionHarness(): ExtensionHarness {
	const providers: Provider[] = [];
	return {
		providers,
		pi: {
			registerProvider(provider: Provider) {
				providers.push(provider);
			},
			on(_event: string, _handler: unknown) {},
			setThinkingLevel(_level: string) {},
		} as ExtensionAPI,
	};
}

export function createRegistryPi(registry: ModelRegistry): ExtensionAPI {
	return {
		registerProvider(provider: Provider) {
			registry.registerProvider(provider);
		},
		on(_event: string, _handler: unknown) {},
		setThinkingLevel(_level: string) {},
	} as ExtensionAPI;
}

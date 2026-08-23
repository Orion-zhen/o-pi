import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { Provider } from "@earendil-works/pi-ai";
import { createEventBus, ModelRegistry, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadModelsJsoncConfig } from "../../src/openai-compatible-provider/config.js";
import { normalizeModelsJsoncConfig } from "../../src/openai-compatible-provider/normalize.js";
import { registerOpenAICompatibleProviders } from "../../src/openai-compatible-provider/register.js";
import type { ModelsJsoncConfig } from "../../src/openai-compatible-provider/schema.js";

export async function normalizeFromText(dir: string, text: string) {
	const config = await loadConfigFromText(dir, text);
	return normalizeModelsJsoncConfig(config, path.join(dir, "models.jsonc"));
}

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

export function normalizeProviders(
	dir: string,
	providers: Record<string, Record<string, unknown>>,
) {
	return normalizeFromText(dir, JSON.stringify({ providers }));
}

export async function normalizeProvider(
	dir: string,
	overrides: Record<string, unknown> = {},
	providerId = "gateway",
) {
	const [provider] = await normalizeFromText(dir, providerConfigText(overrides, providerId));
	if (!provider) throw new Error(`provider ${providerId} was not normalized`);
	return provider;
}

export async function normalizeRuntime(
	dir: string,
	overrides: Record<string, unknown> = {},
	providerId = "gateway",
	modelId = "m",
) {
	const provider = await normalizeProvider(dir, overrides, providerId);
	const runtime = provider.runtimeModels.get(modelId);
	if (!runtime) throw new Error(`runtime ${providerId}/${modelId} missing`);
	return { provider, runtime };
}

export async function loadConfigFromText(dir: string, text: string): Promise<ModelsJsoncConfig> {
	const file = path.join(dir, "models.jsonc");
	await writeFile(file, text);
	const config = await loadModelsJsoncConfig(file);
	if (!config) throw new Error("config unexpectedly missing");
	return config;
}

export interface ExtensionHarness {
	pi: ExtensionAPI;
	providers: Provider[];
}

export function registerProvider(
	config: ModelsJsoncConfig,
	dir: string,
	harness = createExtensionHarness(),
): { provider: Provider; harness: ExtensionHarness } {
	const [provider] = registerOpenAICompatibleProviders(harness.pi, config, path.join(dir, "models.jsonc"));
	if (!provider) throw new Error("provider was not registered");
	return { provider, harness };
}

export function createExtensionHarness(): ExtensionHarness {
	const providers: Provider[] = [];
	return {
		providers,
		pi: {
			events: createEventBus(),
			registerProvider(provider: Provider) {
				providers.push(provider);
			},
			on() {},
			setThinkingLevel() {},
		} as unknown as ExtensionAPI,
	};
}

export function createRegistryPi(registry: ModelRegistry): ExtensionAPI {
	return {
		events: createEventBus(),
		registerProvider(provider: Provider) {
			registry.registerProvider(provider);
		},
		on() {},
		setThinkingLevel() {},
	} as unknown as ExtensionAPI;
}

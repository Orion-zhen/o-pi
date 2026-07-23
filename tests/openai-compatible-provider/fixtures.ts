import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { Provider } from "@earendil-works/pi-ai";
import { createEventBus, ModelRegistry, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	fetchProviderModelsFromEndpoint,
	loadModelsJsoncConfig,
	normalizeModelsJsoncConfig,
	type FetchProviderModelsOptions,
	type ModelsJsoncConfig,
} from "../../src/openai-compatible-provider/index.js";
import { mergeDiscoveredModelConfigs } from "../../src/openai-compatible-provider/models-endpoint.js";

export async function fetchNormalizedProvider(
	dir: string,
	config: ModelsJsoncConfig,
	providerId: string,
	options: FetchProviderModelsOptions,
) {
	const configPath = path.join(dir, "models.jsonc");
	const source = config.providers[providerId];
	if (!source) throw new Error(`provider ${providerId} missing`);
	const discovered = await fetchProviderModelsFromEndpoint(providerId, source, configPath, options);
	const [provider] = normalizeModelsJsoncConfig({
		providers: {
			[providerId]: {
				...source,
				models: mergeDiscoveredModelConfigs(source.models, discovered),
			},
		},
	}, configPath);
	if (!provider) throw new Error(`provider ${providerId} was not normalized`);
	return provider;
}

export async function normalizeFromText(dir: string, text: string) {
	const config = await loadConfigFromText(dir, text);
	return normalizeModelsJsoncConfig(config, path.join(dir, "models.jsonc"));
}

export async function loadConfigFromText(dir: string, text: string): Promise<ModelsJsoncConfig> {
	const file = path.join(dir, "models.jsonc");
	await writeFile(file, text);
	const config = await loadModelsJsoncConfig(file);
	if (!config) throw new Error("config unexpectedly missing");
	return config;
}

export function jsonResponse(value: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) {
	const response = {
		ok: init.ok ?? true,
		status: init.status ?? 200,
		async text() {
			return JSON.stringify(value);
		},
	};
	return init.statusText === undefined ? response : { ...response, statusText: init.statusText };
}

export interface ExtensionHarness {
	pi: ExtensionAPI;
	providers: Provider[];
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

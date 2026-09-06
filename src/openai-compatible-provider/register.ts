import { createProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createProviderAuth } from "./auth.js";
import { fetchProviderModelsFromEndpoint, mergeDiscoveredModelConfigs } from "./models-endpoint.js";
import { buildModels, configuredModels, validateProviderPayload, type ModelOverrides } from "./models.js";
import type { ModelsJsoncConfig } from "./schema.js";
import { createRuntimeStreams } from "./streams.js";

/** 注册原生 Provider，目录持久化和并发刷新由 Pi 管理。 */
export function registerOpenAICompatibleProviders(
	pi: ExtensionAPI,
	config: ModelsJsoncConfig,
	configPath: string,
): void {
	const overridesByProvider = new Map<string, ReadonlyMap<string, ModelOverrides>>();
	const providers = Object.entries(config.providers).map(([id, provider]) => {
		validateProviderPayload(id, provider, configPath);
		const configured = configuredModels(provider.models);
		const models = buildModels(id, provider, configured, configPath);
		const visibleIds = new Set(models.map((model) => model.id));
		const overrides: ReadonlyMap<string, ModelOverrides> = new Map(
			configured.filter((model) => visibleIds.has(model.id)).map((model) => [model.id, model]),
		);
		overridesByProvider.set(id, overrides);
		return createProvider({
			id,
			name: provider.name ?? id,
			baseUrl: provider.baseUrl,
			auth: { apiKey: createProviderAuth(id, provider) },
			models,
			fetchModels: async ({ credential, signal }) => {
				if (credential?.type !== "api_key") {
					throw new TypeError(`Provider "${id}" model refresh requires an API key credential`);
				}
				const discovered = await fetchProviderModelsFromEndpoint(id, provider, configPath, credential, signal);
				return buildModels(id, provider, mergeDiscoveredModelConfigs(configured, discovered), configPath);
			},
			api: createRuntimeStreams(provider, overrides),
		});
	});
	for (const provider of providers) pi.registerProvider(provider);
	pi.on("model_select", (event) => {
		if (event.source === "restore") return;
		const level = overridesByProvider.get(event.model.provider)?.get(event.model.id)?.defaultThinkingLevel;
		if (level !== undefined) pi.setThinkingLevel(level);
	});
}

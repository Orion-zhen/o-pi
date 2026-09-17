import { createProvider, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createProviderAuth } from "./auth.ts";
import { fetchProviderModelsFromEndpoint, mergeDiscoveredModelConfigs } from "./models-endpoint.ts";
import { buildModels, configuredModels, restoreCachedModels, validateProviderPayload, type ModelOverrides } from "./models.ts";
import type { ModelsJsoncConfig } from "./schema.ts";
import { createRuntimeStreams } from "./streams.ts";

/** 注册原生 Provider，目录持久化和并发刷新由 Pi 管理。 */
export function registerOpenAICompatibleProviders(
	pi: ExtensionAPI,
	config: ModelsJsoncConfig,
	configPath: string,
): void {
	const overridesByProvider = new Map<string, ReadonlyMap<string, ModelOverrides>>();
	const providers = Object.entries(config.providers).map(([id, provider]): Provider => {
		validateProviderPayload(id, provider, configPath);
		const configured = configuredModels(provider.models);
		const baseline = buildModels(id, provider, configured, configPath);
		let models: readonly Model<Api>[] = baseline;
		const visibleIds = new Set(models.map((model) => model.id));
		const overrides: ReadonlyMap<string, ModelOverrides> = new Map(
			configured.filter((model) => visibleIds.has(model.id)).map((model) => [model.id, model]),
		);
		overridesByProvider.set(id, overrides);
		const runtime = createProvider({
			id,
			name: provider.name ?? id,
			baseUrl: provider.baseUrl,
			auth: { apiKey: createProviderAuth(id, provider) },
			models: baseline,
			api: createRuntimeStreams(provider, overrides),
		});
		return {
			...runtime,
			getModels: () => models,
			refreshModels: async ({ stored, publish, allowNetwork, credential, signal }) => {
				if (stored) {
					const cached = new Map<string, Model<Api>>(baseline.map((model) => [model.id, model]));
					for (const model of stored.models) {
						if (model.provider === id) cached.set(model.id, model);
					}
					const restored = restoreCachedModels(id, provider, [...cached.values()], configPath);
					if (!await publish({ update: () => { models = restored; } })) return;
				}
				if (!allowNetwork || signal.aborted) return;
				if (credential?.type !== "api_key") {
					throw new TypeError(`Provider "${id}" model refresh requires an API key credential`);
				}
				const discovered = await fetchProviderModelsFromEndpoint(id, provider, configPath, credential, signal);
				if (signal.aborted) return;
				const refreshed = buildModels(id, provider, mergeDiscoveredModelConfigs(configured, discovered), configPath);
				await publish({
					persist: { models: refreshed, checkedAt: Date.now() },
					update: () => { models = refreshed; },
				});
			},
		};
	});
	for (const provider of providers) pi.registerProvider(provider);
	pi.on("model_select", (event) => {
		if (event.source === "restore") return;
		const level = overridesByProvider.get(event.model.provider)?.get(event.model.id)?.defaultThinkingLevel;
		if (level !== undefined) pi.setThinkingLevel(level);
	});
}

import { serviceCompatDefaults } from "./compat-defaults.ts";
import { configObject, isCompatibleService, type ConfigObject, type ModelsDocument } from "./document.ts";
import { configuredModels, type ModelSettings } from "./model-settings.ts";
import { thinkingSettings } from "./thinking-settings.ts";

function withoutDefaults(config: ConfigObject, defaults: ConfigObject): ConfigObject {
	const result: ConfigObject = {};
	for (const [key, value] of Object.entries(config)) {
		const fallback = defaults[key];
		if (configObject(value) && configObject(fallback)) {
			const nested = withoutDefaults(value, fallback);
			if (Object.keys(nested).length) result[key] = nested;
		} else if (JSON.stringify(value) !== JSON.stringify(fallback)) {
			result[key] = value;
		}
	}
	return result;
}

export type ModelSettingsView = ReturnType<typeof modelSettingsView>;

/** 展示、重置和配置比较共用解析结果，不把默认值写入配置。 */
export function modelSettingsView(providerId: string, provider: ConfigObject, model: Pick<ModelSettings, "id" | "defaults" | "configured">) {
	const defaults: ConfigObject = { name: model.id, contextWindow: 128_000, input: ["text"], reasoning: false, ...model.defaults };
	const compat = serviceCompatDefaults(providerId, provider, model);
	const thinking = thinkingSettings(model, compat);
	const overrides = withoutDefaults(model.configured, {
		...defaults,
		thinkingPreset: compat.thinkingPreset,
		compat: compat.compat,
		samplingParams: defaults.samplingParams ?? {},
	});
	if (configObject(overrides.thinkingLevelMap)) {
		const map = { ...overrides.thinkingLevelMap };
		for (const row of thinking.rows) {
			if (!row.modified) delete map[row.level];
		}
		if (Object.keys(map).length) overrides.thinkingLevelMap = map;
		else delete overrides.thinkingLevelMap;
	}
	return { defaults, compat, thinking, overrides };
}

function serviceValues(id: string, provider: ConfigObject): ConfigObject {
	if (!isCompatibleService(provider)) return provider;
	const defaults = serviceCompatDefaults(id, provider);
	const value = withoutDefaults(provider, {
		name: id, authHeader: false, thinkingPreset: defaults.thinkingPreset, compat: defaults.compat,
	});
	// 定义与覆盖分别比较，覆盖层继承原始定义。
	if (Array.isArray(provider.models)) {
		const definitions = { ...provider, modelOverrides: undefined };
		const models = [...provider.models];
		for (const model of configuredModels(definitions)) {
			if (model.manualIndex !== undefined) models[model.manualIndex] = modelSettingsView(id, definitions, model).overrides;
		}
		if (models.length) value.models = models;
		else delete value.models;
	}
	if (configObject(provider.modelOverrides)) {
		const overrides = { ...provider.modelOverrides };
		for (const model of configuredModels(provider)) {
			if (model.overridden) overrides[model.id] = modelSettingsView(id, provider, model).overrides;
		}
		if (Object.keys(overrides).length) value.modelOverrides = overrides;
		else delete value.modelOverrides;
	}
	return value;
}

function sortedValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortedValue);
	if (configObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
	return value;
}

/** 仅用于配置值比较。保留原始文档中的显式值、注释和未知字段。 */
export function comparableModelsDocument(document: ModelsDocument): string {
	const providers = Object.fromEntries(Object.entries(document.providers).map(([id, provider]) => [id, serviceValues(id, provider)]));
	return JSON.stringify(sortedValue({ ...document, providers }));
}

import { equalConfigValues } from "../config-values.ts";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { MERGED_COMPAT_FIELDS, serviceCompatSettings } from "./compat-settings.ts";
import { configObject, isCompatibleService, type ConfigObject, type ModelsDocument } from "./document.ts";
import { configuredModels, type ModelSettings } from "./model-settings.ts";
import { thinkingSettings } from "./thinking-settings.ts";

// 仅 SDK 按键继承的对象逐字段比较，其余对象（含模板变量）整体比较。
const inheritedObjects = new Set([
	"compat", ...MERGED_COMPAT_FIELDS.map((key) => `compat.${key}`),
	"thinkingLevelMap", "samplingParams", "samplingParamsByThinkingLevel",
	...MODEL_THINKING_LEVELS.map((level) => `samplingParamsByThinkingLevel.${level}`),
	"cost", "promptCache", "inputLimits", "inputLimits.images", "inputLimits.images.resize",
]);

function withoutDefaults(config: ConfigObject, defaults: ConfigObject, path = ""): ConfigObject {
	const result: ConfigObject = {};
	for (const [key, value] of Object.entries(config)) {
		const fallback = defaults[key];
		const field = path ? `${path}.${key}` : key;
		if (inheritedObjects.has(field) && configObject(value) && configObject(fallback)) {
			const nested = withoutDefaults(value, fallback, field);
			if (Object.keys(nested).length) result[key] = nested;
		} else if (!equalConfigValues(value, fallback)) {
			result[key] = value;
		}
	}
	return result;
}

export type ModelSettingsView = ReturnType<typeof modelSettingsView>;

/** 展示、重置和配置比较共用解析结果，不把默认值写入配置。 */
export function modelSettingsView(providerId: string, provider: ConfigObject, model: Pick<ModelSettings, "id" | "defaults" | "configured">) {
	const defaults: ConfigObject = { name: model.id, contextWindow: 128_000, input: ["text"], reasoning: false, ...model.defaults };
	const compat = serviceCompatSettings(providerId, provider, model);
	const thinking = thinkingSettings(model, compat.capabilities);
	const overrides = withoutDefaults(model.configured, {
		...defaults,
		compat: compat.defaults,
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
	const compat = serviceCompatSettings(id, provider);
	const value = withoutDefaults(provider, {
		name: id, authHeader: false, compat: compat.defaults,
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

/** 仅用于配置值比较。保留原始文档中的显式值、注释和未知字段。 */
export function comparableModelsDocument(document: ModelsDocument): ModelsDocument {
	const providers = Object.fromEntries(Object.entries(document.providers).map(([id, provider]) => [id, serviceValues(id, provider)]));
	return { ...document, providers };
}

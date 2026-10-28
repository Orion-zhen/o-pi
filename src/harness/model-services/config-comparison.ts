import { equalConfigValues } from "../config-values.ts";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { MERGED_COMPAT_FIELDS, serviceCompatSettings } from "./compat-settings.ts";
import { configObject, type ConfigObject, type ModelsDocument } from "./document.ts";
import { configuredModels, modelDefaults, type ModelSettings } from "./model-settings.ts";
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

/** 只消除已知默认值，供草稿比较和重置状态共用，不改写原配置。 */
export function modelConfigOverrides(providerId: string, provider: ConfigObject, model: Pick<ModelSettings, "id" | "defaults" | "configured">): ConfigObject {
	const defaults = modelDefaults(model);
	const compat = serviceCompatSettings(providerId, provider, model);
	const overrides = withoutDefaults(model.configured, {
		...defaults,
		compat: compat.defaults,
		samplingParams: defaults.samplingParams ?? {},
	});
	if (model.defaults !== undefined && configObject(overrides.thinkingLevelMap)) {
		const map = { ...overrides.thinkingLevelMap };
		for (const row of thinkingSettings(model, compat.capabilities).rows) {
			if (!row.modified) delete map[row.level];
		}
		if (Object.keys(map).length) overrides.thinkingLevelMap = map;
		else delete overrides.thinkingLevelMap;
	}
	return overrides;
}

function serviceValues(id: string, provider: ConfigObject): ConfigObject {
	const compat = serviceCompatSettings(id, provider);
	const value = withoutDefaults(provider, {
		name: id, authHeader: false, compat: compat.defaults,
	});
	// 定义与覆盖分别比较，覆盖层继承原始定义。
	if (Array.isArray(provider.models)) {
		const models = (provider.models as (ConfigObject & { id: string })[]).map((configured) =>
			modelConfigOverrides(id, provider, { id: configured.id, defaults: {}, configured }));
		if (models.length) value.models = models;
		else delete value.models;
	}
	if (configObject(provider.modelOverrides)) {
		const overrides = { ...provider.modelOverrides };
		for (const model of configuredModels(provider)) {
			if (model.overridden) overrides[model.id] = modelConfigOverrides(id, provider, model);
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

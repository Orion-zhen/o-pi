import type { ModelCandidate } from "./model-candidates.ts";
import { configObject, type ConfigObject, type ConfigPath } from "./document.ts";

export interface ModelSettings {
	id: string;
	manualIndex: number | undefined;
	overridden: boolean;
	path: ConfigPath;
	configured: ConfigObject;
	defaults: ConfigObject;
}

/** 编辑中的配置可以尚未通过 schema 校验。只读取结构完整的模型条目。 */
export function configuredModels(provider: ConfigObject, candidates: ModelCandidate[] = []): ModelSettings[] {
	const manual = new Map<string, { index: number; value: ConfigObject }>();
	if (Array.isArray(provider.models)) provider.models.forEach((value: unknown, index) => {
		if (configObject(value) && typeof value.id === "string") manual.set(value.id, { index, value });
	});
	const overrides = configObject(provider.modelOverrides) ? provider.modelOverrides : {};
	const inferred = new Map(candidates.filter((candidate) => candidate.thinkingLevelMap).map((candidate) => [candidate.id, candidate]));
	return [...new Set([...manual.keys(), ...Object.keys(overrides)])].map((id) => {
		const definition = manual.get(id);
		const overridden = Object.hasOwn(overrides, id);
		const configured = overridden ? overrides[id] : definition?.value;
		const candidate = inferred.get(id);
		const defaults: ConfigObject = {
			...(candidate ? { reasoning: candidate.reasoning, thinkingLevelMap: candidate.thinkingLevelMap } : {}),
			...(overridden ? definition?.value : {}),
		};
		if (candidate) defaults.thinkingLevelMap = {
			...candidate.thinkingLevelMap, ...(configObject(defaults.thinkingLevelMap) ? defaults.thinkingLevelMap : {}),
		};
		return {
			id, manualIndex: definition?.index, overridden, defaults,
			configured: configObject(configured) ? configured : {},
			path: overridden || !definition ? ["modelOverrides", id] : ["models", definition.index],
		};
	});
}

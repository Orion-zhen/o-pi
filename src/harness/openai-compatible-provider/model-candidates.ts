import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { configuredModels } from "./model-settings.ts";
import { configObject, type ConfigObject, type ConfigEdit } from "./document.ts";

export interface ModelCandidate {
	id: string;
	contextWindow?: number;
	input?: ("text" | "image")[];
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

function suffixBase(id: string): string {
	const colon = id.lastIndexOf(":");
	return colon > 0 && MODEL_THINKING_LEVELS.some((level) => id.slice(colon + 1) === level) ? id.slice(0, colon) : id;
}

/** 只在后缀模式下折叠已返回的等级，不从通用思考能力推测路由。 */
export function modelCandidates(provider: ConfigObject, candidates: ModelCandidate[]): ModelCandidate[] {
	const presets = new Map(configuredModels(provider).map((model) =>
		[model.id, model.configured.thinkingPreset ?? model.defaults.thinkingPreset ?? provider.thinkingPreset]));
	const raw = new Map(candidates.map((candidate) => [candidate.id, candidate]));
	const result = new Map<string, ModelCandidate>();
	for (const candidate of candidates) {
		const base = suffixBase(candidate.id);
		if ((presets.get(base) ?? provider.thinkingPreset) !== "model-suffix") {
			result.set(candidate.id, candidate);
			continue;
		}
		if (result.has(base)) continue;
		const thinkingLevelMap: ThinkingLevelMap = {};
		for (const level of MODEL_THINKING_LEVELS) {
			if (raw.has(`${base}:${level}`)) thinkingLevelMap[level] = level;
			else if (level !== "off" || !raw.has(base)) thinkingLevelMap[level] = null;
		}
		result.set(base, {
			...(raw.get(base) ?? candidate), id: base,
			reasoning: MODEL_THINKING_LEVELS.some((level) => level !== "off" && typeof thinkingLevelMap[level] === "string"),
			thinkingLevelMap,
		});
	}
	return [...result.values()];
}

/** 只补入未配置的能力字段，不添加模型。返回逐字段修改以保留配置注释。 */
export function modelCandidateEdits(provider: ConfigObject, candidates: ModelCandidate[]): ConfigEdit[] {
	const folded = modelCandidates(provider, candidates);
	const inferred = new Set(folded.filter((candidate) => candidate.thinkingLevelMap).map(({ id }) => id));
	const edits: ConfigEdit[] = [];
	for (const model of configuredModels(provider, folded)) {
		if (!inferred.has(model.id)) continue;
		const { configured, defaults } = model;
		if (configured.reasoning === undefined) edits.push({ path: [...model.path, "reasoning"], value: defaults.reasoning });
		const ownMap = configObject(configured.thinkingLevelMap) ? configured.thinkingLevelMap : {};
		if (configObject(defaults.thinkingLevelMap)) for (const [level, value] of Object.entries(defaults.thinkingLevelMap)) {
			if (ownMap[level] === undefined) edits.push({ path: [...model.path, "thinkingLevelMap", level], value });
		}
	}
	return edits;
}

import type { Model, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { invalidModelsConfig } from "./errors.ts";
import { isModelThinkingLevel, modelOptions, MODEL_THINKING_LEVEL_VALUES, type OpenAIApiName, type ProviderConfig } from "./schema.ts";

export interface DiscoveredModel {
	id: string;
	contextWindow?: number;
	input?: ("text" | "image")[];
}

/** 仅构建初始目录或发现目录，静态模型的完整元数据由 SDK 从 models.json 应用。 */
export function buildModels(
	providerId: string,
	provider: ProviderConfig,
	entries: readonly (DiscoveredModel & { api?: OpenAIApiName })[],
	configPath: string,
): Model<OpenAIApiName>[] {
	const ids = new Set<string>();
	const models = entries.map((entry): Model<OpenAIApiName> => {
		if (ids.has(entry.id)) throw invalidModelsConfig(configPath, `provider "${providerId}" contains duplicate model "${entry.id}"`);
		ids.add(entry.id);
		return {
			id: entry.id,
			name: entry.id,
			api: entry.api ?? provider.api,
			provider: providerId,
			baseUrl: provider.baseUrl,
			reasoning: false,
			input: entry.input ?? ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: entry.contextWindow ?? 128_000,
			maxTokens: 16_384,
		};
	});
	const variantsByBase = new Map<string, Set<ModelThinkingLevel>>();
	const hidden = new Set<string>();
	for (const model of models) {
		const separator = model.id.lastIndexOf(":");
		if (separator <= 0) continue;
		const level = model.id.slice(separator + 1);
		if (!isModelThinkingLevel(level)) continue;
		const baseId = model.id.slice(0, separator);
		const preset = modelOptions(provider, baseId).thinkingPreset ?? provider.thinkingPreset;
		if (!ids.has(baseId) || preset !== "model-suffix") continue;
		let variants = variantsByBase.get(baseId);
		if (!variants) {
			variants = new Set();
			variantsByBase.set(baseId, variants);
		}
		variants.add(level);
		hidden.add(model.id);
	}
	return models.flatMap((model) => {
		if (hidden.has(model.id)) return [];
		const variants = variantsByBase.get(model.id);
		if (!variants) return [model];
		const thinkingLevelMap: ThinkingLevelMap = {};
		for (const level of MODEL_THINKING_LEVEL_VALUES) {
			if (variants.has(level)) thinkingLevelMap[level] = level;
			else if (level !== "off") thinkingLevelMap[level] = null;
		}
		return [{ ...model, reasoning: true, thinkingLevelMap }];
	});
}

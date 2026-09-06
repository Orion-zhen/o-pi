import { getSupportedThinkingLevels, type Model, type ModelThinkingLevel, type ThinkingLevelMap } from "@earendil-works/pi-ai";

import { invalidModelsJsonc } from "./errors.js";
import {
	isModelThinkingLevel,
	MODEL_THINKING_LEVEL_VALUES,
	type ModelConfig,
	type OpenAIApiName,
	type ProviderConfig,
	type ThinkingPresetName,
} from "./schema.js";
import { resolveCompat } from "./thinking-presets.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const CORE_PAYLOAD_FIELDS = new Set(["model", "messages", "input", "tools", "stream"]);

/** 请求期只读取这些配置字段，原生模型属性始终取自当前 Model。 */
export type ModelOverrides = Pick<ModelConfig, "thinkingPreset" | "defaultThinkingLevel" | "dropParams" | "headers">;

export function configuredModels(models: ProviderConfig["models"]): ModelConfig[] {
	return Array.isArray(models) ? models.map((model) => typeof model === "string" ? { id: model } : model) : [];
}

export function validateProviderPayload(providerId: string, provider: ProviderConfig, configPath: string): void {
	for (const key of Object.keys(provider.extraBody ?? {})) {
		if (CORE_PAYLOAD_FIELDS.has(key)) {
			throw invalidModelsJsonc(configPath, `providers.${providerId}.extraBody.${key} cannot override core request field "${key}"`);
		}
	}
	assertNoCoreDropParams(provider.dropParams, configPath, `providers.${providerId}.dropParams`);
}

/** 启动和发现共用模型构建流程，不创建提供方状态或请求期映射。 */
export function buildModels(
	providerId: string,
	provider: ProviderConfig,
	entries: readonly ModelConfig[],
	configPath: string,
): Model<OpenAIApiName>[] {
	return prepareModels(entries, provider.thinkingPreset ?? "none", providerId, configPath).map(({ model, index }) => {
		const fieldPath = `providers.${providerId}.models[${index}]`;
		assertNoCoreDropParams(model.dropParams, configPath, `${fieldPath}.dropParams`);
		const inferredReasoning = model.defaultThinkingLevel !== undefined || model.thinkingLevelMap !== undefined;
		if (model.reasoning === false && inferredReasoning) {
			throw invalidModelsJsonc(configPath, `${fieldPath}.reasoning=false conflicts with defaultThinkingLevel/thinkingLevelMap`);
		}
		const native: Model<OpenAIApiName> = {
			id: model.id,
			name: model.name ?? model.id,
			api: model.api ?? provider.api ?? "openai-completions",
			provider: providerId,
			baseUrl: model.baseUrl ?? provider.baseUrl,
			reasoning: model.reasoning ?? inferredReasoning,
			...(model.thinkingLevelMap !== undefined ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
			input: model.input ?? ["text"],
			cost: model.cost ?? { ...ZERO_COST },
			contextWindow: model.contextWindow ?? 128_000,
			maxTokens: model.maxTokens ?? 16_384,
			...(model.samplingParams !== undefined ? { samplingParams: model.samplingParams } : {}),
			compat: resolveCompat(model.thinkingPreset ?? provider.thinkingPreset ?? "none", provider.compat, model.compat),
		};
		if (model.defaultThinkingLevel !== undefined && !getSupportedThinkingLevels(native).includes(model.defaultThinkingLevel)) {
			throw invalidModelsJsonc(configPath, `${fieldPath}.defaultThinkingLevel "${model.defaultThinkingLevel}" is not supported by its Pi thinkingLevelMap`);
		}
		return native;
	});
}

interface PreparedModel {
	model: ModelConfig;
	index: number;
}

/** 保留原始索引用于报错，把 model-suffix 的已知等级变体折叠到基础模型。 */
function prepareModels(
	entries: readonly ModelConfig[],
	providerPreset: ThinkingPresetName,
	providerId: string,
	configPath: string,
): PreparedModel[] {
	const prepared = entries.map((model, index) => ({ model, index }));
	const byId = new Map<string, PreparedModel>();
	for (const entry of prepared) {
		if (byId.has(entry.model.id)) {
			throw invalidModelsJsonc(configPath, `provider "${providerId}" contains duplicate model "${entry.model.id}"`);
		}
		byId.set(entry.model.id, entry);
	}

	const variantsByBase = new Map<string, Set<ModelThinkingLevel>>();
	const hiddenVariants = new Set<string>();
	for (const { model } of prepared) {
		const separator = model.id.lastIndexOf(":");
		if (separator <= 0) continue;
		const level = model.id.slice(separator + 1);
		if (!isModelThinkingLevel(level)) continue;
		const baseId = model.id.slice(0, separator);
		const base = byId.get(baseId);
		if (!base || (base.model.thinkingPreset ?? providerPreset) !== "model-suffix") continue;
		let variants = variantsByBase.get(baseId);
		if (!variants) {
			variants = new Set();
			variantsByBase.set(baseId, variants);
		}
		variants.add(level);
		hiddenVariants.add(model.id);
	}

	return prepared.flatMap((entry) => {
		if (hiddenVariants.has(entry.model.id)) return [];
		const variants = variantsByBase.get(entry.model.id);
		if (!variants) return [entry];
		const inferredMap: ThinkingLevelMap = {};
		for (const level of MODEL_THINKING_LEVEL_VALUES) {
			if (variants.has(level)) inferredMap[level] = level;
			else if (level !== "off") inferredMap[level] = null;
		}
		return [{
			...entry,
			model: { ...entry.model, thinkingLevelMap: { ...inferredMap, ...entry.model.thinkingLevelMap } },
		}];
	});
}

function assertNoCoreDropParams(values: readonly string[] | undefined, configPath: string, fieldPath: string): void {
	for (const key of values ?? []) {
		if (CORE_PAYLOAD_FIELDS.has(key)) {
			throw invalidModelsJsonc(configPath, `${fieldPath} cannot remove core request field "${key}"`);
		}
	}
}

import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

export const THINKING_LEVEL_PREFERENCE_ENTRY = "thinking-level-preference";

const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export interface ThinkingLevelPreferenceData {
	provider: string;
	modelId: string;
	level: ModelThinkingLevel;
}

export interface ThinkingLevelPreferenceBranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

type ThinkingLevelPreferenceModel = Pick<Model<Api>, "id" | "provider">;

export interface ThinkingLevelPreferencePort {
	appendEntry(customType: string, data: ThinkingLevelPreferenceData): void;
	getThinkingLevel(): ModelThinkingLevel;
	setThinkingLevel(level: ModelThinkingLevel): void;
}

/** 按会话分支记忆各模型的 thinking level，并过滤模型切换产生的临时 clamp。 */
export class ThinkingLevelPreferences {
	private activeModel: ThinkingLevelPreferenceModel | undefined;
	private preferences = new Map<string, ModelThinkingLevel>();

	constructor(private readonly port: ThinkingLevelPreferencePort) {}

	restore(
		branchEntries: readonly ThinkingLevelPreferenceBranchEntry[],
		model: ThinkingLevelPreferenceModel | undefined,
	): void {
		this.preferences = readPreferences(branchEntries);
		this.activate(model);
	}

	selectModel(model: ThinkingLevelPreferenceModel): void {
		this.activate(model);
	}

	selectLevel(level: ModelThinkingLevel, model: ThinkingLevelPreferenceModel | undefined): void {
		if (model === undefined || !modelsAreEqual(this.activeModel, model)) return;
		this.remember(model, level);
	}

	private activate(model: ThinkingLevelPreferenceModel | undefined): void {
		this.activeModel = model;
		if (model === undefined) return;

		const savedLevel = this.preferences.get(modelKey(model));
		if (savedLevel === undefined) {
			this.remember(model, this.port.getThinkingLevel());
			return;
		}

		if (this.port.getThinkingLevel() !== savedLevel) this.port.setThinkingLevel(savedLevel);
		const effectiveLevel = this.port.getThinkingLevel();
		if (effectiveLevel !== savedLevel) this.remember(model, effectiveLevel);
	}

	private remember(model: ThinkingLevelPreferenceModel, level: ModelThinkingLevel): void {
		const key = modelKey(model);
		if (this.preferences.get(key) === level) return;
		this.preferences.set(key, level);
		this.port.appendEntry(THINKING_LEVEL_PREFERENCE_ENTRY, {
			provider: model.provider,
			modelId: model.id,
			level,
		});
	}
}

function readPreferences(
	branchEntries: readonly ThinkingLevelPreferenceBranchEntry[],
): Map<string, ModelThinkingLevel> {
	const preferences = new Map<string, ModelThinkingLevel>();
	for (const entry of branchEntries) {
		if (entry.type !== "custom" || entry.customType !== THINKING_LEVEL_PREFERENCE_ENTRY) continue;
		const preference = parsePreference(entry.data);
		if (preference === undefined) continue;
		preferences.set(modelKey({ provider: preference.provider, id: preference.modelId }), preference.level);
	}
	return preferences;
}

function parsePreference(value: unknown): ThinkingLevelPreferenceData | undefined {
	if (!isRecord(value)) return undefined;
	const provider = value["provider"];
	const modelId = value["modelId"];
	const level = value["level"];
	if (
		typeof provider !== "string"
		|| provider.length === 0
		|| typeof modelId !== "string"
		|| modelId.length === 0
		|| !isThinkingLevel(level)
	) return undefined;
	return { provider, modelId, level };
}

function modelKey(model: ThinkingLevelPreferenceModel): string {
	return `${model.provider}/${model.id}`;
}

function modelsAreEqual(
	left: ThinkingLevelPreferenceModel | undefined,
	right: ThinkingLevelPreferenceModel,
): boolean {
	return left?.provider === right.provider && left.id === right.id;
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ModelThinkingLevel);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

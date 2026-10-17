import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type { ServiceCompatDefaults } from "./compat-defaults.ts";
import type { ModelSettings } from "./model-settings.ts";
import { suffixModelId } from "./thinking-presets.ts";
import { configObject } from "./document.ts";

function thinkingMap(value: unknown): ThinkingLevelMap {
	const map: ThinkingLevelMap = {};
	if (configObject(value)) for (const level of MODEL_THINKING_LEVELS) {
		const entry = value[level];
		if (entry === null || typeof entry === "string") map[level] = entry;
	}
	return map;
}

export type ThinkingSettings = ReturnType<typeof thinkingSettings>;

export function thinkingSettings({ id, defaults, configured }: Pick<ModelSettings, "id" | "defaults" | "configured">, resolved: ServiceCompatDefaults) {
	const base = thinkingMap(defaults.thinkingLevelMap);
	const map = thinkingMap(configured.thinkingLevelMap);
	const compat = { ...resolved.compat, ...(configObject(configured.compat) ? configured.compat : {}) };
	const preset = configured.thinkingPreset ?? resolved.thinkingPreset;
	const suffix = preset === "model-suffix";
	// SDK 的能力接口要求完整 Model，能力判断只使用 reasoning 和 thinkingLevelMap。
	const model: Model<"openai-completions"> = {
		id, name: id, provider: "", api: "openai-completions", baseUrl: "",
		reasoning: (configured.reasoning ?? defaults.reasoning) === true, thinkingLevelMap: { ...base, ...map },
		input: ["text"], contextWindow: 128_000, maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const available = getSupportedThinkingLevels(model);
	const enabled = getSupportedThinkingLevels({ ...model, reasoning: true });
	const inherited = getSupportedThinkingLevels({ ...model, reasoning: true, thinkingLevelMap: base });
	const format = preset === "auto"
		? resolved.api === "openai-responses" ? "openai" : compat.thinkingFormat
		: preset;
	const namedEffort = resolved.api === "openai-responses"
		? ["openai", "openrouter", "string-thinking", "chat-template-effort"].includes(String(format))
		: ["openrouter", "string-thinking", "chat-template-effort"].includes(String(format)) || format === "openai" && compat.supportsReasoningEffort !== false;
	const omitsOffEffort = resolved.api !== "openai-responses" && (format === "openai" || format === "chat-template-effort");
	const rows = MODEL_THINKING_LEVELS.map((level) => {
		const own = map[level];
		const protocolValue = namedEffort && (level !== "off" || !omitsOffEffort)
			? level === "off" ? "none" : level : undefined;
		const defaultValue = typeof base[level] === "string" ? base[level] : protocolValue;
		return {
			level,
			available: available.includes(level),
			enabled: enabled.includes(level),
			modified: own !== undefined && (enabled.includes(level) !== inherited.includes(level)
				|| typeof own === "string" && own !== (suffix ? base[level] : defaultValue)),
			value: typeof own === "string" ? own : "",
			defaultValue,
			omitsEffort: namedEffort && level === "off" && protocolValue === undefined,
			enableValue: inherited.includes(level) ? undefined : defaultValue ?? level,
			targetModel: suffixModelId(id, model.thinkingLevelMap, level),
		};
	});
	return { reasoning: model.reasoning, suffix, rows, modified: rows.some((row) => row.modified) };
}

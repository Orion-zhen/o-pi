import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type { ModelSettings } from "./model-settings.ts";
import type { ThinkingCapabilities } from "./thinking-capabilities.ts";

export type ThinkingSettings = ReturnType<typeof thinkingSettings>;

export function thinkingSettings({ id, defaults, configured }: Pick<ModelSettings, "id" | "defaults" | "configured">, capabilities: ThinkingCapabilities | undefined) {
	const base = (defaults.thinkingLevelMap as ThinkingLevelMap | undefined) ?? {};
	const map = (configured.thinkingLevelMap as ThinkingLevelMap | undefined) ?? {};
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
	const rows = MODEL_THINKING_LEVELS.map((level) => {
		const own = map[level];
		const encoding = level === "off" ? capabilities?.off : capabilities?.on;
		const protocolValue = encoding?.effort === "level" ? level : encoding?.effort === "none" ? "none" : undefined;
		const defaultValue = typeof base[level] === "string" ? base[level] : protocolValue;
		const mapsEffort = encoding !== undefined && encoding.effort !== false;
		const effect = encoding?.toggle ? level === "off" ? "关闭思考" : "开启思考" : "不发送等级值";
		return {
			level,
			available: available.includes(level),
			enabled: enabled.includes(level),
			modified: own !== undefined && (enabled.includes(level) !== inherited.includes(level)
				|| typeof own === "string" && own !== defaultValue),
			value: typeof own === "string" ? own : "",
			defaultValue,
			mapsEffort,
			effect,
			enableValue: inherited.includes(level) ? undefined : defaultValue ?? level,
		};
	});
	return { reasoning: model.reasoning, rows, modified: rows.some((row) => row.modified) };
}

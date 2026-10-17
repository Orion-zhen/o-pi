import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { configObject, type ConfigObject } from "../../../harness/openai-compatible-provider/validation.ts";

export function thinkingMapping(provider: ConfigObject, defaults: ConfigObject, configured: ConfigObject, modelId: string) {
	const base = configObject(defaults.thinkingLevelMap) ? defaults.thinkingLevelMap : {};
	const map = configObject(configured.thinkingLevelMap) ? configured.thinkingLevelMap : {};
	const reasoning = (configured.reasoning ?? defaults.reasoning) === true;
	const api = configured.api ?? defaults.api ?? provider.api;
	const preset = configured.thinkingPreset ?? defaults.thinkingPreset ?? provider.thinkingPreset;
	const compat: ConfigObject = {};
	for (const layer of [provider, defaults, configured]) {
		if (configObject(layer.compat)) Object.assign(compat, layer.compat);
	}
	const format = compat.thinkingFormat;
	const effort = compat.supportsReasoningEffort;
	const suffix = preset === "model-suffix";
	// 只展示能由当前协议确定的默认值，不复制 SDK 按地址推断兼容格式的逻辑。
	const namedEffort = api === "openai-responses"
		? preset === undefined || ["openai", "openrouter", "string-thinking", "chat-template-effort"].includes(String(preset))
		: ["openrouter", "string-thinking"].includes(String(format)) || format === "openai" && effort !== false;
	const rows = MODEL_THINKING_LEVELS.map((level) => {
		const own = map[level];
		const inherited = base[level];
		const mapped = own === undefined ? inherited : own;
		const supported = (value: unknown) => reasoning
			? value !== null && (level !== "xhigh" && level !== "max" || typeof value === "string")
			: level === "off";
		const protocolValue = namedEffort && (level !== "off" || api === "openai-responses" || format !== "openai")
			? level === "off" ? "none" : level : undefined;
		const defaultValue = typeof inherited === "string" ? inherited : protocolValue;
		return {
			level,
			available: supported(mapped),
			modified: own !== undefined,
			value: typeof own === "string" ? own : "",
			placeholder: defaultValue ?? (namedEffort && level === "off" ? "不发送等级值" : "协议默认"),
			enableValue: supported(inherited) ? undefined : defaultValue ?? level,
			targetModel: level === "off" && mapped === undefined ? modelId : `${modelId}:${level}`,
		};
	});
	return { reasoning, suffix, rows, modified: Object.keys(map).length > 0 };
}

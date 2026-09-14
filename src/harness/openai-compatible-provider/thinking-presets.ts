import type { Api, Model, ModelThinkingLevel, OpenAICompletionsCompat } from "@earendil-works/pi-ai";

import type { OpenAICompatConfig, ThinkingPresetName } from "./schema.js";

const DEFAULT_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
} as const satisfies OpenAICompletionsCompat;

/** provider thinking preset 到 Pi 原生 OpenAI completions compat 的映射。 */
const THINKING_PRESETS = {
	none: {
		supportsReasoningEffort: false,
		thinkingFormat: "openai",
	},
	"model-suffix": {
		supportsReasoningEffort: false,
		thinkingFormat: "openai",
	},
	openai: {
		supportsReasoningEffort: true,
		thinkingFormat: "openai",
	},
	openrouter: {
		supportsReasoningEffort: false,
		thinkingFormat: "openrouter",
	},
	deepseek: {
		supportsReasoningEffort: false,
		thinkingFormat: "deepseek",
	},
	together: {
		supportsReasoningEffort: false,
		thinkingFormat: "together",
	},
	zai: {
		supportsReasoningEffort: false,
		thinkingFormat: "zai",
	},
	qwen: {
		supportsReasoningEffort: false,
		thinkingFormat: "qwen",
	},
	"qwen-chat-template": {
		supportsReasoningEffort: false,
		thinkingFormat: "qwen-chat-template",
	},
	"chat-template-enabled": {
		supportsReasoningEffort: false,
		thinkingFormat: "chat-template",
		chatTemplateKwargs: {
			enable_thinking: { $var: "thinking.enabled" },
		},
	},
	"chat-template-effort": {
		supportsReasoningEffort: false,
		thinkingFormat: "chat-template",
		chatTemplateKwargs: {
			reasoning_effort: { $var: "thinking.effort" },
		},
	},
	"string-thinking": {
		supportsReasoningEffort: false,
		thinkingFormat: "string-thinking",
	},
	"ant-ling": {
		supportsReasoningEffort: false,
		thinkingFormat: "ant-ling",
	},
} as const satisfies Record<ThinkingPresetName, OpenAICompletionsCompat>;

/** 合并保守默认值、thinking 编码和 provider/model 原生 compat。 */
export function resolveCompat(
	thinkingPreset: ThinkingPresetName,
	providerCompat: OpenAICompatConfig | undefined,
	modelCompat: OpenAICompatConfig | undefined,
): OpenAICompatConfig {
	return {
		...DEFAULT_COMPAT,
		...THINKING_PRESETS[thinkingPreset],
		...providerCompat,
		...modelCompat,
	};
}

/** Responses 没有对应的原生 compat 编码，按当前 Model 补齐非 OpenAI 预设。 */
export function applyResponsesThinkingPreset(
	payload: Record<string, unknown>,
	model: Model<Api>,
	preset: ThinkingPresetName,
	level: ModelThinkingLevel,
): void {
	if (model.api !== "openai-responses" || !model.reasoning || preset === "openai" || preset === "model-suffix") return;
	stripThinkingPayload(payload);
	if (preset === "none") return;

	const enabled = level !== "off";
	const mapped = model.thinkingLevelMap?.[level];
	const effort = mapped === null ? undefined : mapped ?? (enabled ? level : "none");
	const supportsEffort = model.compat !== undefined
		&& "supportsReasoningEffort" in model.compat
		&& model.compat.supportsReasoningEffort === true;
	switch (preset) {
		case "openrouter":
			if (effort !== undefined) payload.reasoning = { effort };
			return;
		case "deepseek":
			if (enabled) payload.thinking = { type: "enabled" };
			else if (model.thinkingLevelMap?.off !== null) payload.thinking = { type: "disabled" };
			if (enabled && effort !== undefined && supportsEffort) payload.reasoning_effort = effort;
			return;
		case "together":
			payload.reasoning = { enabled };
			if (enabled && effort !== undefined && supportsEffort) payload.reasoning_effort = effort;
			return;
		case "zai":
			payload.thinking = enabled ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
			if (enabled && effort !== undefined && supportsEffort) payload.reasoning_effort = effort;
			return;
		case "qwen":
			payload.enable_thinking = enabled;
			return;
		case "qwen-chat-template":
			payload.chat_template_kwargs = { enable_thinking: enabled, preserve_thinking: true };
			return;
		case "chat-template-enabled":
			payload.chat_template_kwargs = { enable_thinking: enabled };
			return;
		case "chat-template-effort":
			if (effort !== undefined) payload.chat_template_kwargs = { reasoning_effort: effort };
			return;
		case "string-thinking":
			if (effort !== undefined) payload.thinking = effort;
			return;
		case "ant-ling":
			if (enabled && typeof mapped === "string") payload.reasoning = { effort: mapped };
			return;
	}
}

export function applyModelSuffixPayload(payload: Record<string, unknown>, model: Model<Api>, level: ModelThinkingLevel): void {
	stripThinkingPayload(payload);
	const mapped = model.thinkingLevelMap?.[level];
	const useSuffix = mapped !== null && (level !== "off" || mapped !== undefined);
	payload.model = useSuffix ? `${model.id}:${level}` : model.id;
}

function stripThinkingPayload(payload: Record<string, unknown>): void {
	for (const field of ["reasoning_effort", "reasoning", "thinking", "enable_thinking", "chat_template_kwargs"]) delete payload[field];
	if (!Array.isArray(payload.include)) return;
	const include = payload.include.filter((value) => value !== "reasoning.encrypted_content");
	if (include.length > 0) payload.include = include;
	else delete payload.include;
}

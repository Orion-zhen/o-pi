import type { Model } from "@earendil-works/pi-ai";

import type { CompatPresetName, ThinkingPresetName } from "./schema.js";

type OpenAICompat = NonNullable<Model<"openai-completions">["compat"]>;

/** 当前 Pi 版本支持的 OpenAI Chat Completions compat preset。 */
export const COMPAT_PRESETS = {
	openai: {},
	openai_compatible: {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
	},
	local: {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsUsageInStreaming: true,
		maxTokensField: "max_tokens",
	},
	qwen: {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsUsageInStreaming: true,
		maxTokensField: "max_tokens",
	},
	deepseek: {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsUsageInStreaming: true,
		maxTokensField: "max_tokens",
	},
	strict: {
		supportsStore: false,
		supportsDeveloperRole: true,
		supportsReasoningEffort: true,
		supportsUsageInStreaming: true,
	},
} as const satisfies Record<CompatPresetName, OpenAICompat>;

const NON_STANDARD_SAMPLING_PRESETS = new Set<CompatPresetName>(["local", "qwen", "deepseek"]);

/** provider thinking preset 到 Pi 原生 OpenAI completions compat 的映射。 */
export const THINKING_PRESETS = {
	none: {
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
	qwen_chat_template: {
		supportsReasoningEffort: false,
		thinkingFormat: "qwen-chat-template",
	},
	chat_template_enabled: {
		supportsReasoningEffort: false,
		thinkingFormat: "chat-template",
		chatTemplateKwargs: {
			enable_thinking: { $var: "thinking.enabled" },
		},
	},
	chat_template_effort: {
		supportsReasoningEffort: false,
		thinkingFormat: "chat-template",
		chatTemplateKwargs: {
			reasoning_effort: { $var: "thinking.effort" },
		},
	},
	string_thinking: {
		supportsReasoningEffort: false,
		thinkingFormat: "string-thinking",
	},
	ant_ling: {
		supportsReasoningEffort: false,
		thinkingFormat: "ant-ling",
	},
} as const satisfies Record<ThinkingPresetName, OpenAICompat>;

/** 判断 preset 是否允许 top_k/min_p/repetition_penalty 这类非 OpenAI 标准采样字段。 */
export function allowsNonStandardSampling(preset: CompatPresetName): boolean {
	return NON_STANDARD_SAMPLING_PRESETS.has(preset);
}

/** 展开 compat/thinking preset，并允许模型级 advanced.compat 最后覆盖。 */
export function resolveCompat(
	preset: CompatPresetName | undefined,
	thinkingPreset: ThinkingPresetName,
	modelCompat: Record<string, unknown> | undefined,
): OpenAICompat {
	return {
		...COMPAT_PRESETS[preset ?? "openai_compatible"],
		...THINKING_PRESETS[thinkingPreset],
		...(modelCompat ?? {}),
	} as OpenAICompat;
}

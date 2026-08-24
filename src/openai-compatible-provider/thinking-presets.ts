import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";

import type { OpenAICompatConfig, ThinkingPresetName } from "./schema.js";

const DEFAULT_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
} as const satisfies OpenAICompletionsCompat;

/** provider thinking preset 到 Pi 原生 OpenAI completions compat 的映射。 */
export const THINKING_PRESETS = {
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

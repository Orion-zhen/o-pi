import type { Model } from "@earendil-works/pi-ai";

import type { CompatPresetName } from "./schema.js";

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
		thinkingFormat: "qwen-chat-template",
	},
	deepseek: {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsUsageInStreaming: true,
		maxTokensField: "max_tokens",
		thinkingFormat: "deepseek",
	},
	strict: {
		supportsStore: false,
		supportsDeveloperRole: true,
		supportsReasoningEffort: true,
		supportsUsageInStreaming: true,
	},
} as const satisfies Record<CompatPresetName, OpenAICompat>;

const NON_STANDARD_SAMPLING_PRESETS = new Set<CompatPresetName>(["local", "qwen", "deepseek"]);

/** 判断 preset 是否允许 top_k/min_p/repetition_penalty 这类非 OpenAI 标准采样字段。 */
export function allowsNonStandardSampling(preset: CompatPresetName): boolean {
	return NON_STANDARD_SAMPLING_PRESETS.has(preset);
}

/** 展开 provider preset，并允许模型级 advanced.compat 覆盖。 */
export function resolveCompat(preset: CompatPresetName | undefined, modelCompat: Record<string, unknown> | undefined): OpenAICompat {
	return {
		...COMPAT_PRESETS[preset ?? "openai_compatible"],
		...(modelCompat ?? {}),
	} as OpenAICompat;
}

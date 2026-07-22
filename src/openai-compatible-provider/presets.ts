import type { Model } from "@earendil-works/pi-ai";

import type { CompatPresetName, ThinkingPresetName } from "./schema.js";

type OpenAICompat = NonNullable<Model<"openai-completions">["compat"]>;
type CompatOverride = Model<"openai-completions">["compat"] | Model<"openai-responses">["compat"];

/** 当前 Pi 版本支持的 OpenAI Chat Completions compat preset。 */
export const COMPAT_PRESETS = {
	openai: {},
	"openai-compatible": {
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
} as const satisfies Record<ThinkingPresetName, OpenAICompat>;

/** 判断 preset 是否允许 top_k/min_p/repetition_penalty 这类非 OpenAI 标准采样字段。 */
export function allowsNonStandardSampling(preset: CompatPresetName): boolean {
	return NON_STANDARD_SAMPLING_PRESETS.has(preset);
}

/** 展开 preset，并按 provider、model 原生 compat 的顺序覆盖。 */
export function resolveCompat(
	preset: CompatPresetName | undefined,
	thinkingPreset: ThinkingPresetName,
	providerCompat: CompatOverride,
	modelCompat: CompatOverride,
): OpenAICompat {
	const presetCompat = COMPAT_PRESETS[preset ?? "openai-compatible"];
	const thinkingCompat = THINKING_PRESETS[thinkingPreset];
	const merged: OpenAICompat = {
		...presetCompat,
		...thinkingCompat,
		...(providerCompat ?? {}),
		...(modelCompat ?? {}),
	};
	for (const key of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs"] as const) {
		const nested = {
			...nestedCompat(presetCompat, key),
			...nestedCompat(thinkingCompat, key),
			...nestedCompat(providerCompat, key),
			...nestedCompat(modelCompat, key),
		};
		if (Object.keys(nested).length > 0) Object.assign(merged, { [key]: nested });
	}
	return merged;
}

function nestedCompat(value: object | undefined, key: string): Record<string, unknown> | undefined {
	if (!value || !(key in value)) return undefined;
	const nested: unknown = Reflect.get(value, key);
	return isRecord(nested) ? nested : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type { Model } from "@earendil-works/pi-ai";

import type { ThinkingPresetName } from "./schema.js";

type OpenAICompat = NonNullable<Model<"openai-completions">["compat"]>;
type CompatOverride = Model<"openai-completions">["compat"] | Model<"openai-responses">["compat"];

const DEFAULT_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
} as const satisfies OpenAICompat;

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

/** 合并保守默认值、thinking 编码和 provider/model 原生 compat。 */
export function resolveCompat(
	thinkingPreset: ThinkingPresetName,
	providerCompat: CompatOverride,
	modelCompat: CompatOverride,
): OpenAICompat {
	const thinkingCompat = THINKING_PRESETS[thinkingPreset];
	const merged: OpenAICompat = {
		...DEFAULT_COMPAT,
		...thinkingCompat,
		...(providerCompat ?? {}),
		...(modelCompat ?? {}),
	};
	for (const key of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs"] as const) {
		const nested = {
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

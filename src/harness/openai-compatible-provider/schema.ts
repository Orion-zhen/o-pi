import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelsDocument } from "./document.ts";
import { MODEL_THINKING_LEVELS, ModelThinkingLevelSchema } from "@earendil-works/pi-ai/providers/model-schema";
import { OpenAICompletionsCompatSchema } from "@earendil-works/pi-ai/providers/compat-schema";
import { Type, type Static } from "typebox";

export const THINKING_PRESETS = [
	"auto", "none", "model-suffix",
	...OpenAICompletionsCompatSchema.properties.thinkingFormat.anyOf.map(({ const: format }) => format),
	"chat-template-enabled", "chat-template-effort",
] as const;
const ThinkingPresetSchema = Type.Enum(THINKING_PRESETS);

export function thinkingPresetIssue(api: unknown, preset: unknown): string | undefined {
	if (api === "openai-responses" && (preset === "baseten" || preset === "chat-template"))
		return `${preset} requires openai-completions`;
}
const OpenAIApiSchema = Type.Enum(["openai-completions", "openai-responses"]);
export const MODEL_THINKING_LEVEL_VALUES = MODEL_THINKING_LEVELS;

const ModelExtensionProperties = {
	thinkingPreset: Type.Optional(ThinkingPresetSchema),
	defaultThinkingLevel: Type.Optional(ModelThinkingLevelSchema),
	dropParams: Type.Optional(Type.Array(Type.String())),
};
const ModelOptionsSchema = Type.Object(ModelExtensionProperties);
const ModelIdentitySchema = Type.Object({ id: Type.String({ minLength: 1 }), ...ModelExtensionProperties });
const ProviderExtensionProperties = {
	thinkingPreset: Type.Optional(ThinkingPresetSchema),
	timeoutMs: Type.Optional(Type.Number({ minimum: 0 })),
	maxRetries: Type.Optional(Type.Integer({ minimum: 0 })),
	dropParams: Type.Optional(Type.Array(Type.String())),
	extraBody: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
};

// 默认思考等级不依赖 provider 实现，也不限制原生 API。
export const ProviderOptionsSchema = Type.Object({
	models: Type.Optional(Type.Array(ModelIdentitySchema)),
	modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOptionsSchema)),
	...ProviderExtensionProperties,
});

// 只读取注册和 API 分派必需的原生字段，其余模型元数据由 SDK 处理。
export const ProviderConfigSchema = Type.Object({
	...ProviderOptionsSchema.properties,
	name: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.String({ minLength: 1 }),
	api: OpenAIApiSchema,
	models: Type.Optional(Type.Array(Type.Object({
		...ModelIdentitySchema.properties,
		api: Type.Optional(OpenAIApiSchema),
	}))),
});

export function hasRequestExtensions(config: ProviderOptions): boolean {
	return config.timeoutMs !== undefined || config.maxRetries !== undefined || config.extraBody !== undefined
		|| [config, ...(config.models ?? []), ...Object.values(config.modelOverrides ?? {})]
			.some((entry) => entry.thinkingPreset !== undefined || entry.dropParams !== undefined);
}

export type ThinkingPresetName = Static<typeof ThinkingPresetSchema>;
export type OpenAIApiName = Static<typeof OpenAIApiSchema>;
export type ProviderOptions = Static<typeof ProviderOptionsSchema>;
export type ProviderConfig = Static<typeof ProviderConfigSchema>;
export type ModelOverrides = Static<typeof ModelOptionsSchema>;
export interface ModelsConfig {
	source: ModelsDocument;
	providers: Record<string, ProviderConfig>;
	defaultThinkingLevels: Record<string, Record<string, ModelThinkingLevel>>;
}

/** 原生 modelOverrides 是最终用户覆盖层，扩展选项遵循同一顺序。 */
export function modelOptions(provider: ProviderOptions, id: string): ModelOverrides {
	const model = provider.models?.find((entry) => entry.id === id);
	return { ...model, ...provider.modelOverrides?.[id] };
}

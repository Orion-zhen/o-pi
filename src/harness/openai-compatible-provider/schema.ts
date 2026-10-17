import { StringEnum, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { MODEL_THINKING_LEVELS, ModelThinkingLevelSchema } from "@earendil-works/pi-ai/providers/model-schema";
import { Type, type Static } from "typebox";

const ThinkingPresetSchema = StringEnum([
	"none", "model-suffix", "openai", "openrouter", "deepseek", "together", "zai", "qwen",
	"qwen-chat-template", "chat-template-enabled", "chat-template-effort", "string-thinking", "ant-ling",
] as const);
const OpenAIApiSchema = StringEnum(["openai-completions", "openai-responses"] as const);
export const MODEL_THINKING_LEVEL_VALUES = MODEL_THINKING_LEVELS;
export function isModelThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return MODEL_THINKING_LEVELS.some((level) => level === value);
}

const ModelExtensionProperties = {
	thinkingPreset: Type.Optional(ThinkingPresetSchema),
	defaultThinkingLevel: Type.Optional(ModelThinkingLevelSchema),
	dropParams: Type.Optional(Type.Array(Type.String())),
};
const ModelOptionsSchema = Type.Object(ModelExtensionProperties);
const ModelIdentitySchema = Type.Object({ id: Type.String({ minLength: 1 }), ...ModelExtensionProperties });
const ProviderExtensionProperties = {
	discoverModels: Type.Optional(Type.Boolean()),
	modelsEndpoint: Type.Optional(Type.String({ minLength: 1 })),
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

// 只读取目录请求和 API 分派必需的原生字段，其余模型元数据由 SDK 处理。
export const ProviderConfigSchema = Type.Object({
	...ProviderOptionsSchema.properties,
	name: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.String({ minLength: 1 }),
	api: OpenAIApiSchema,
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	authHeader: Type.Optional(Type.Boolean()),
	models: Type.Optional(Type.Array(Type.Object({
		...ModelIdentitySchema.properties,
		api: Type.Optional(OpenAIApiSchema),
	}))),
});

export function hasProviderExtensions(value: object): boolean {
	if (Object.keys(ProviderExtensionProperties).some((key) => key in value)) return true;
	const models: unknown[] = "models" in value && Array.isArray(value.models) ? value.models : [];
	const overrides = "modelOverrides" in value && typeof value.modelOverrides === "object" && value.modelOverrides !== null
		? Object.values(value.modelOverrides) : [];
	return [...models, ...overrides].some((model) => typeof model === "object" && model !== null
		&& Object.keys(ModelExtensionProperties).some((key) => key in model));
}

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
	providers: Record<string, ProviderConfig>;
	defaultThinkingLevels: Record<string, Record<string, ModelThinkingLevel>>;
}

/** 原生 modelOverrides 是最终用户覆盖层，扩展选项遵循同一顺序。 */
export function modelOptions(provider: ProviderOptions, id: string): ModelOverrides {
	const model = provider.models?.find((entry) => entry.id === id);
	return { ...model, ...provider.modelOverrides?.[id] };
}

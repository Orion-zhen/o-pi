import {
	StringEnum,
	type ModelThinkingLevel,
	type OpenAICompletionsCompat,
	type OpenAIResponsesCompat,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

/** OpenAI-compatible 请求中思考等级的编码预设。 */
export const THINKING_PRESET_NAMES = [
	"none",
	"model-suffix",
	"openai",
	"openrouter",
	"deepseek",
	"together",
	"zai",
	"qwen",
	"qwen-chat-template",
	"chat-template-enabled",
	"chat-template-effort",
	"string-thinking",
	"ant-ling",
] as const;
export const ThinkingPresetNameSchema = StringEnum(THINKING_PRESET_NAMES);

export const OPENAI_API_NAMES = ["openai-completions", "openai-responses"] as const;
const OpenAIApiSchema = StringEnum(OPENAI_API_NAMES);

// Pi 只导出 thinking level 类型，没有导出重复可消费的运行时枚举。normalize
// 阶段通过 getSupportedThinkingLevels() 校验默认值与 map。
const ThinkingLevelSchema = Type.Unsafe<ModelThinkingLevel>(Type.String({ minLength: 1 }));
const ThinkingLevelMapSchema = Type.Unsafe<ThinkingLevelMap>(
	Type.Record(Type.String({ minLength: 1 }), Type.Union([Type.String(), Type.Null()])),
);

const CostRatesSchema = {
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
};
const ModelCostSchema = Type.Object(
	{
		...CostRatesSchema,
		tiers: Type.Optional(Type.Array(Type.Object({ inputTokensAbove: Type.Number(), ...CostRatesSchema }, { additionalProperties: false }))),
	},
	{ additionalProperties: false },
);

/** Pi 原生 OpenAI compat 的并集；字符串索引允许未来字段无需同步本仓库即可透传。 */
export type OpenAICompatConfig = OpenAICompletionsCompat & OpenAIResponsesCompat & Record<string, unknown>;

// pi-ai 当前只导出 compat TypeScript 类型，没有导出运行时 schema。这里仅校验对象边界，
// 具体字段由对应 Pi transport 消费；未知字段保留，以兼容后续 Pi 版本。
const CompatSchema = Type.Unsafe<OpenAICompatConfig>(Type.Object({}, { additionalProperties: Type.Unknown() }));
const SamplingParamsSchema = Type.Record(Type.String({ minLength: 1 }), Type.Unknown());

const ModelConfigSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		name: Type.Optional(Type.String({ minLength: 1 })),
		api: Type.Optional(OpenAIApiSchema),
		baseUrl: Type.Optional(Type.String({ minLength: 1 })),
		reasoning: Type.Optional(Type.Boolean()),
		thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
		input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
		cost: Type.Optional(ModelCostSchema),
		contextWindow: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		maxTokens: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		compat: Type.Optional(CompatSchema),

		thinkingPreset: Type.Optional(ThinkingPresetNameSchema),
		defaultThinkingLevel: Type.Optional(ThinkingLevelSchema),
		samplingParams: Type.Optional(SamplingParamsSchema),
		dropParams: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);

const ProviderModelsSchema = Type.Union([
	Type.Literal("auto"),
	Type.Array(Type.Union([Type.String({ minLength: 1 }), ModelConfigSchema]), { minItems: 1 }),
]);

const ProviderConfigSchema = Type.Object(
	{
		name: Type.Optional(Type.String({ minLength: 1 })),
		baseUrl: Type.String({ minLength: 1 }),
		apiKey: Type.Optional(Type.String()),
		api: Type.Optional(OpenAIApiSchema),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		compat: Type.Optional(CompatSchema),
		models: Type.Optional(ProviderModelsSchema),

		thinkingPreset: Type.Optional(ThinkingPresetNameSchema),
		modelsEndpoint: Type.Optional(Type.String({ minLength: 1 })),
		timeoutMs: Type.Optional(Type.Number({ minimum: 0 })),
		maxRetries: Type.Optional(Type.Number({ minimum: 0 })),
		dropParams: Type.Optional(Type.Array(Type.String())),
		extraBody: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

/** ~/.pi/agent/models.jsonc 的根 schema；字段尽量与 Pi models.json/Provider/Model 对齐。 */
export const ModelsJsoncConfigSchema = Type.Object(
	{
		providers: Type.Record(Type.String({ minLength: 1 }), ProviderConfigSchema),
	},
	{ additionalProperties: false },
);

export type ModelConfig = Static<typeof ModelConfigSchema>;
export type ThinkingPresetName = Static<typeof ThinkingPresetNameSchema>;
export type OpenAIApiName = Static<typeof OpenAIApiSchema>;
export type ProviderConfig = Static<typeof ProviderConfigSchema>;
export type ModelsJsoncConfig = Static<typeof ModelsJsoncConfigSchema>;

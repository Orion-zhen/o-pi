import { StringEnum, type Model, type ModelThinkingLevel, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

/** OpenAI-compatible 请求中思考参数的编码预设。 */
export const THINKING_PRESET_NAMES = [
	"none",
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

const SamplingDefaultsSchema = Type.Object(
	{
		temperature: Type.Optional(Type.Number()),
		topP: Type.Optional(Type.Number()),
		topK: Type.Optional(Type.Number()),
		minP: Type.Optional(Type.Number()),
		maxTokens: Type.Optional(Type.Number()),
		presencePenalty: Type.Optional(Type.Number()),
		frequencyPenalty: Type.Optional(Type.Number()),
		repetitionPenalty: Type.Optional(Type.Number()),
		seed: Type.Optional(Type.Number()),
		stop: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);

const ChatTemplateValueSchema = Type.Union([
	Type.String(),
	Type.Number(),
	Type.Boolean(),
	Type.Null(),
	Type.Object(
		{
			$var: Type.Union([Type.Literal("thinking.enabled"), Type.Literal("thinking.effort")]),
			omitWhenOff: Type.Optional(Type.Boolean()),
		},
		{ additionalProperties: false },
	),
]);
const PercentilesSchema = Type.Object(
	{
		p50: Type.Optional(Type.Number()),
		p75: Type.Optional(Type.Number()),
		p90: Type.Optional(Type.Number()),
		p99: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);
const OpenRouterRoutingSchema = Type.Object(
	{
		allow_fallbacks: Type.Optional(Type.Boolean()),
		require_parameters: Type.Optional(Type.Boolean()),
		data_collection: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("allow")])),
		zdr: Type.Optional(Type.Boolean()),
		enforce_distillable_text: Type.Optional(Type.Boolean()),
		order: Type.Optional(Type.Array(Type.String())),
		only: Type.Optional(Type.Array(Type.String())),
		ignore: Type.Optional(Type.Array(Type.String())),
		quantizations: Type.Optional(Type.Array(Type.String())),
		sort: Type.Optional(Type.Union([
			Type.String(),
			Type.Object(
				{ by: Type.Optional(Type.String()), partition: Type.Optional(Type.Union([Type.String(), Type.Null()])) },
				{ additionalProperties: false },
			),
		])),
		max_price: Type.Optional(Type.Object(
			{
				prompt: Type.Optional(Type.Union([Type.Number(), Type.String()])),
				completion: Type.Optional(Type.Union([Type.Number(), Type.String()])),
				image: Type.Optional(Type.Union([Type.Number(), Type.String()])),
				audio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
				request: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			},
			{ additionalProperties: false },
		)),
		preferred_min_throughput: Type.Optional(Type.Union([Type.Number(), PercentilesSchema])),
		preferred_max_latency: Type.Optional(Type.Union([Type.Number(), PercentilesSchema])),
	},
	{ additionalProperties: false },
);
const VercelGatewayRoutingSchema = Type.Object(
	{
		only: Type.Optional(Type.Array(Type.String())),
		order: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);

const CompatSchema = Type.Unsafe<
	NonNullable<Model<"openai-completions">["compat"] | Model<"openai-responses">["compat"]>
>(
	Type.Object(
		{
			supportsStore: Type.Optional(Type.Boolean()),
			supportsDeveloperRole: Type.Optional(Type.Boolean()),
			supportsReasoningEffort: Type.Optional(Type.Boolean()),
			supportsUsageInStreaming: Type.Optional(Type.Boolean()),
			maxTokensField: Type.Optional(Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")])),
			requiresToolResultName: Type.Optional(Type.Boolean()),
			requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
			requiresThinkingAsText: Type.Optional(Type.Boolean()),
			requiresReasoningContentOnAssistantMessages: Type.Optional(Type.Boolean()),
			thinkingFormat: Type.Optional(StringEnum([
				"openai", "openrouter", "deepseek", "together", "zai", "qwen", "chat-template",
				"qwen-chat-template", "string-thinking", "ant-ling",
			] as const)),
			chatTemplateKwargs: Type.Optional(Type.Record(Type.String(), ChatTemplateValueSchema)),
			cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
			sessionAffinityFormat: Type.Optional(Type.Union([
				Type.Literal("openai"), Type.Literal("openai-nosession"), Type.Literal("openrouter"),
			])),
			sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
			supportsStrictMode: Type.Optional(Type.Boolean()),
			supportsLongCacheRetention: Type.Optional(Type.Boolean()),
			deferredToolsMode: Type.Optional(Type.Literal("kimi")),
			openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
			vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
			zaiToolStream: Type.Optional(Type.Boolean()),
			supportsToolSearch: Type.Optional(Type.Boolean()),
		},
		{ additionalProperties: false },
	),
);

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
		defaults: Type.Optional(SamplingDefaultsSchema),
		dropParams: Type.Optional(Type.Array(Type.String())),
		extraBody: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
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

export type SamplingDefaults = Static<typeof SamplingDefaultsSchema>;
export type ModelConfig = Static<typeof ModelConfigSchema>;
export type ThinkingPresetName = Static<typeof ThinkingPresetNameSchema>;
export type OpenAIApiName = Static<typeof OpenAIApiSchema>;
export type ProviderConfig = Static<typeof ProviderConfigSchema>;
export type ModelsJsoncConfig = Static<typeof ModelsJsoncConfigSchema>;

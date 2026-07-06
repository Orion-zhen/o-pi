import { Type, type Static } from "typebox";

/** OpenAI-compatible 兼容预设名称，用户只需选择一个高层 preset。 */
export const CompatPresetNameSchema = Type.Union([
	Type.Literal("openai"),
	Type.Literal("openai_compatible"),
	Type.Literal("local"),
	Type.Literal("qwen"),
	Type.Literal("deepseek"),
	Type.Literal("strict"),
]);

/** Pi 当前支持的推理强度档位；配置后会在选中模型时自动切换。 */
export const ReasoningEffortSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
]);

const SamplingDefaultsSchema = Type.Object(
	{
		temperature: Type.Optional(Type.Number()),
		top_p: Type.Optional(Type.Number()),
		top_k: Type.Optional(Type.Number()),
		min_p: Type.Optional(Type.Number()),
		max_tokens: Type.Optional(Type.Number()),
		presence_penalty: Type.Optional(Type.Number()),
		frequency_penalty: Type.Optional(Type.Number()),
		repetition_penalty: Type.Optional(Type.Number()),
		seed: Type.Optional(Type.Number()),
		stop: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);

const ModelAdvancedSchema = Type.Object(
	{
		compat: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		drop_params: Type.Optional(Type.Array(Type.String())),
		extra_body: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

const ModelConfigSchema = Type.Object(
	{
		model: Type.String({ minLength: 1 }),
		display_name: Type.Optional(Type.String({ minLength: 1 })),
		context_window: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		max_tokens: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		reasoning_effort: Type.Optional(ReasoningEffortSchema),
		input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
		defaults: Type.Optional(SamplingDefaultsSchema),
		advanced: Type.Optional(ModelAdvancedSchema),
	},
	{ additionalProperties: false },
);

const ProviderAdvancedSchema = Type.Object(
	{
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		timeout_ms: Type.Optional(Type.Number({ minimum: 0 })),
		max_retries: Type.Optional(Type.Number({ minimum: 0 })),
		drop_params: Type.Optional(Type.Array(Type.String())),
		extra_body: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

const ProviderConfigSchema = Type.Object(
	{
		display_name: Type.Optional(Type.String({ minLength: 1 })),
		base_url: Type.String({ minLength: 1 }),
		api_key: Type.Optional(Type.String()),
		api: Type.Optional(Type.Union([Type.Literal("chat"), Type.Literal("responses")])),
		compat: Type.Optional(CompatPresetNameSchema),
		models: Type.Array(Type.Union([Type.String({ minLength: 1 }), ModelConfigSchema]), { minItems: 1 }),
		advanced: Type.Optional(ProviderAdvancedSchema),
	},
	{ additionalProperties: false },
);

/** ~/.pi/agent/models.jsonc 的根 schema；扩展只读取 providers。 */
export const ModelsJsoncConfigSchema = Type.Object(
	{
		providers: Type.Record(Type.String({ minLength: 1 }), ProviderConfigSchema),
	},
	{ additionalProperties: false },
);

/** 模型级默认采样参数；provider 级采样参数会被语义校验拒绝。 */
export type SamplingDefaults = Static<typeof SamplingDefaultsSchema>;
/** 单个模型配置；字符串模型会在 normalize 阶段转换为该结构。 */
export type ModelConfig = Static<typeof ModelConfigSchema>;
/** 兼容预设名称。 */
export type CompatPresetName = Static<typeof CompatPresetNameSchema>;
/** 模型默认推理强度。 */
export type ReasoningEffort = Static<typeof ReasoningEffortSchema>;
/** 单个 provider 配置。 */
export type ProviderConfig = Static<typeof ProviderConfigSchema>;
/** models.jsonc 根配置。 */
export type ModelsJsoncConfig = Static<typeof ModelsJsoncConfigSchema>;

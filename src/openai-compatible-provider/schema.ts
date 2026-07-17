import { StringEnum, type ModelThinkingLevel, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

/** OpenAI-compatible 兼容预设名称，用户只需选择一个高层 preset。 */
export const COMPAT_PRESET_NAMES = ["openai", "openai_compatible", "local", "qwen", "deepseek", "strict"] as const;
export const CompatPresetNameSchema = StringEnum(COMPAT_PRESET_NAMES);

/** OpenAI-compatible 请求中思考参数的编码预设。 */
export const THINKING_PRESET_NAMES = [
	"none",
	"openai",
	"openrouter",
	"deepseek",
	"together",
	"zai",
	"qwen",
	"qwen_chat_template",
	"chat_template_enabled",
	"chat_template_effort",
	"string_thinking",
	"ant_ling",
] as const;
export const ThinkingPresetNameSchema = StringEnum(THINKING_PRESET_NAMES);

// Pi 只导出 thinking level 类型，没有导出重复可消费的运行时枚举。schema 接受字符串，
// normalize 阶段通过 Pi 的 getSupportedThinkingLevels() 校验默认值与 map。
const ThinkingLevelSchema = Type.Unsafe<ModelThinkingLevel>(Type.String({ minLength: 1 }));
const ThinkingLevelMapSchema = Type.Unsafe<ThinkingLevelMap>(
	Type.Record(Type.String({ minLength: 1 }), Type.Union([Type.String(), Type.Null()])),
);

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
		thinking_level: Type.Optional(ThinkingLevelSchema),
		thinking_level_map: Type.Optional(ThinkingLevelMapSchema),
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

const ProviderModelsSchema = Type.Union([
	Type.Literal("auto"),
	Type.Array(Type.Union([Type.String({ minLength: 1 }), ModelConfigSchema]), { minItems: 1 }),
]);

const ProviderConfigSchema = Type.Object(
	{
		display_name: Type.Optional(Type.String({ minLength: 1 })),
		base_url: Type.String({ minLength: 1 }),
		api_key: Type.Optional(Type.String()),
		api: Type.Optional(Type.Union([Type.Literal("chat"), Type.Literal("responses")])),
		compat: Type.Optional(CompatPresetNameSchema),
		thinking: Type.Optional(ThinkingPresetNameSchema),
		models_endpoint: Type.Optional(Type.String({ minLength: 1 })),
		models: Type.Optional(ProviderModelsSchema),
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
/** 思考参数编码预设名称。 */
export type ThinkingPresetName = Static<typeof ThinkingPresetNameSchema>;
/** 单个 provider 配置。 */
export type ProviderConfig = Static<typeof ProviderConfigSchema>;
/** models.jsonc 根配置。 */
export type ModelsJsoncConfig = Static<typeof ModelsJsoncConfigSchema>;

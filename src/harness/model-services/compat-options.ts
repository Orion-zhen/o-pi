import { ChatTemplateKwargValueSchema, OpenAICompletionsCompatSchema, type ChatTemplateKwargValue } from "@earendil-works/pi-ai/providers/compat-schema";
import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import type { Schema } from "@earendil-works/pi-schema";

type Properties<T> = { [K in keyof Required<T>]: Schema<Exclude<T[K], undefined>> };

/** SDK 固定 schema 的结构适配集中在这里，选项直接取字面量。 */
function literalValues<T>(schema: Schema<T>): T[] {
	const variants = schema.anyOf as readonly { const: T }[];
	return variants.map((variant) => variant.const);
}

const compat = OpenAICompletionsCompatSchema.properties as Properties<OpenAICompletionsCompat>;
export const THINKING_FORMATS = literalValues(compat.thinkingFormat);
export const MAX_TOKENS_FIELDS = literalValues(compat.maxTokensField);

const variants = ChatTemplateKwargValueSchema.anyOf as readonly Schema[];
const variable = variants.find((schema) => schema.type === "object") as {
	properties: Properties<Extract<ChatTemplateKwargValue, object>>;
};
export const TEMPLATE_VARIABLES = literalValues(variable.properties.$var);

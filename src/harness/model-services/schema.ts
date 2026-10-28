import { ModelsConfigSchema, ModelsJsonSchemas } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js";
import { ModelThinkingLevelSchema } from "@earendil-works/pi-ai/providers/model-schema";
import { Type, type Static } from "typebox";

const modelExtensions = {
	defaultThinkingLevel: Type.Optional(ModelThinkingLevelSchema),
	dropParams: Type.Optional(Type.Array(Type.String())),
};

// 原生字段和默认值沿用 SDK，扩展只补充自身字段。
export const modelsConfigSchema = Type.Object({
	...ModelsConfigSchema.properties,
	providers: Type.Record(Type.String(), Type.Object({
		...ModelsJsonSchemas.provider.properties,
		models: Type.Optional(Type.Array(Type.Object({ ...ModelsJsonSchemas.model.properties, ...modelExtensions }))),
		modelOverrides: Type.Optional(Type.Record(Type.String(), Type.Object({ ...ModelsJsonSchemas.modelOverride.properties, ...modelExtensions }))),
		dropParams: Type.Optional(Type.Array(Type.String())),
		extraBody: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	})),
});

export type ModelsConfig = Static<typeof modelsConfigSchema>;
export type ProviderConfig = ModelsConfig["providers"][string];

/** 原生 modelOverrides 是最终用户覆盖层，扩展选项遵循同一顺序。 */
export function modelOptions(provider: ProviderConfig, id: string) {
	const model = provider.models?.find((entry) => entry.id === id);
	return { ...model, ...provider.modelOverrides?.[id] };
}

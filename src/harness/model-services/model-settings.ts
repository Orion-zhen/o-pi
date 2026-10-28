import type { ConfigObject, ConfigPath } from "./document.ts";

export interface ModelSettings {
	id: string;
	manualIndex: number | undefined;
	overridden: boolean;
	path: ConfigPath;
	configured: ConfigObject;
	// 没有本地定义时，内置模型的默认值未知，不能套用新模型默认值。
	defaults: ConfigObject | undefined;
}

export function modelDefaults({ id, defaults }: Pick<ModelSettings, "id" | "defaults">): ConfigObject {
	return defaults === undefined ? {} : { name: id, contextWindow: 128_000, input: ["text"], reasoning: false, ...defaults };
}

export function configuredModels(provider: ConfigObject): ModelSettings[] {
	const definitions = (provider.models as (ConfigObject & { id: string })[] | undefined) ?? [];
	const overrides = (provider.modelOverrides as Record<string, ConfigObject> | undefined) ?? {};
	const models = new Map<string, ModelSettings>(definitions.map((configured, index) => [configured.id, {
		id: configured.id, manualIndex: index, overridden: false, path: ["models", index], defaults: {}, configured,
	}]));
	for (const [id, configured] of Object.entries(overrides)) {
		const definition = models.get(id);
		models.set(id, {
			id, manualIndex: definition?.manualIndex, overridden: true, path: ["modelOverrides", id],
			defaults: definition?.configured, configured,
		});
	}
	return [...models.values()];
}

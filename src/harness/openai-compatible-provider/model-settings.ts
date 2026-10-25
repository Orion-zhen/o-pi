import type { ConfigObject, ConfigPath } from "./document.ts";

export interface ModelSettings {
	id: string;
	manualIndex: number | undefined;
	overridden: boolean;
	path: ConfigPath;
	configured: ConfigObject;
	defaults: ConfigObject;
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
			defaults: definition?.configured ?? {}, configured,
		});
	}
	return [...models.values()];
}

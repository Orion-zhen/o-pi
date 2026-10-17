import { applyEdits, modify } from "jsonc-parser";
import { configObject, type ConfigObject } from "../../../harness/openai-compatible-provider/validation.ts";
import type { ServiceModel } from "../../model-services.ts";

export type ConfigPath = (string | number)[];
export type ChangeConfig = (path: ConfigPath, value: unknown) => void;
export function editServiceConfig(content: string, path: ConfigPath, value: unknown): string {
	const source = content || '{\n\t"providers": {}\n}\n';
	return applyEdits(source, modify(source, path, value,
		{ formattingOptions: { insertSpaces: false, tabSize: 4 } }));
}
interface ServiceModelDraft {
	id: string;
	manualIndex: number | undefined;
	overridden: boolean;
	path: ConfigPath;
	configured: ConfigObject;
	defaults: ConfigObject;
}

/** 目录已排除运行时手动定义，草稿只负责选择编辑层和它的默认值。 */
export function serviceModels(provider: ConfigObject, catalog: ServiceModel[]): ServiceModelDraft[] {
	const manual = new Map<string, { index: number; value: ConfigObject }>();
	if (Array.isArray(provider.models)) provider.models.forEach((value: unknown, index) => {
		if (configObject(value) && typeof value.id === "string") manual.set(value.id, { index, value });
	});
	const discovered = new Map(catalog.map((model) => [model.id, model]));
	const overrides = configObject(provider.modelOverrides) ? provider.modelOverrides : {};
	const ids = new Set([...manual.keys(), ...discovered.keys(), ...Object.keys(overrides)]);
	return [...ids].map((id) => {
		const definition = manual.get(id);
		const overridden = Object.hasOwn(overrides, id);
		const configured = overridden ? overrides[id] : definition?.value;
		let defaults: ConfigObject = {};
		if (!definition) defaults = { ...discovered.get(id) };
		else if (overridden) defaults = definition.value;
		return {
			id, manualIndex: definition?.index, overridden, defaults,
			configured: configObject(configured) ? configured : {},
			path: overridden || !definition ? ["modelOverrides", id] : ["models", definition.index],
		};
	});
}
export function serviceAddress(value: unknown): string {
	if (typeof value !== "string") return "";
	try { return new URL(value).host; } catch { return ""; }
}

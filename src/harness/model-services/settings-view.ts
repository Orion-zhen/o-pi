import { serviceCompatSettings } from "./compat-settings.ts";
import { modelConfigOverrides } from "./config-comparison.ts";
import type { ConfigObject } from "./document.ts";
import { modelDefaults, type ModelSettings } from "./model-settings.ts";
import { thinkingSettings } from "./thinking-settings.ts";

export type ModelSettingsView = ReturnType<typeof modelSettingsView>;

/** 展示继承值，不把默认值写入配置。 */
export function modelSettingsView(providerId: string, provider: ConfigObject, model: Pick<ModelSettings, "id" | "defaults" | "configured">) {
	const defaults = modelDefaults(model);
	const compat = serviceCompatSettings(providerId, provider, model);
	const api = model.configured.api ?? defaults.api ?? provider.api;
	const thinking = thinkingSettings(model, compat.capabilities);
	const overrides = modelConfigOverrides(providerId, provider, model);
	return { defaults, compat, thinking, overrides, api };
}

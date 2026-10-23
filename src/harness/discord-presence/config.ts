import {
	CONFIG_DEFINITIONS,
	ConfigError,
	loadValidatedMergedConfig,
} from "../config-loader.ts";
import { PRESENCE_TEMPLATE_KEYS, PRESENCE_TEMPLATE_PATTERN, type DiscordPresenceConfig, type PresenceProfileConfig } from "./types.ts";

const TEMPLATE_KEYS = new Set<string>(PRESENCE_TEMPLATE_KEYS);

// 分层 Schema 允许档位稀疏覆盖，合并后再检查每个档位是否完整。
type LoadedConfig = Omit<DiscordPresenceConfig, "profiles"> & {
	$schema?: string;
	profiles: Record<string, Partial<PresenceProfileConfig>>;
};

export async function loadDiscordPresenceConfig(cwd: string): Promise<DiscordPresenceConfig> {
	const loaded = await loadValidatedMergedConfig<LoadedConfig>(CONFIG_DEFINITIONS.discordPresence, cwd);
	const raw = loaded.merged;
	// 通用加载器已经完成合并，只修正 details 的整对象替换语义。
	for (const layer of loaded.layers) {
		const overlay = layer.value as Partial<LoadedConfig>;
		for (const [name, profile] of Object.entries(overlay.profiles ?? {})) {
			if (profile.details !== undefined) raw.profiles[name] = { ...raw.profiles[name], details: profile.details };
		}
	}
	const { $schema: _schema, profiles, ...rest } = raw;
	validateProfiles(profiles);
	const config: DiscordPresenceConfig = { ...rest, profiles };
	if (config.enabled && config.application_id.length === 0) {
		throw new ConfigError("application_id is required when Discord presence is enabled.");
	}
	if (!Object.hasOwn(config.profiles, config.profile)) {
		throw new ConfigError("Selected Discord presence profile does not exist.", { profile: config.profile });
	}
	validateTemplates(config);
	return config;
}

function validateProfiles(
	profiles: Record<string, Partial<PresenceProfileConfig>>,
): asserts profiles is Record<string, PresenceProfileConfig> {
	for (const [name, profile] of Object.entries(profiles)) {
		if (profile.details === undefined || profile.state === undefined || profile.show_elapsed === undefined) {
			throw new ConfigError("Discord presence profile is incomplete.", { profile: name });
		}
	}
}

function validateTemplates(config: DiscordPresenceConfig): void {
	const templates: Array<{ path: string; value: string }> = [
		{ path: "assets.large.text", value: config.assets.large.text },
		{ path: "assets.small.text", value: config.assets.small.text },
	];
	for (const [name, profile] of Object.entries(config.profiles)) {
		templates.push({ path: `profiles.${name}.state`, value: profile.state });
		for (const [kind, value] of Object.entries(profile.details)) {
			templates.push({ path: `profiles.${name}.details.${kind}`, value });
		}
	}
	for (const template of templates) {
		for (const match of template.value.matchAll(PRESENCE_TEMPLATE_PATTERN)) {
			const placeholder = match[0].slice(1, -1);
			if (!TEMPLATE_KEYS.has(placeholder)) {
				throw new ConfigError("Discord presence template contains an unknown placeholder.", {
					path: template.path, placeholder,
				});
			}
		}
	}
}

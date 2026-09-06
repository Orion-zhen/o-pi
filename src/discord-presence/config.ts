import {
	CONFIG_DEFINITIONS,
	agentSchemaPath,
	createCompleteSchemaValidator,
	createSchemaValidator,
	loadValidatedMergedConfig,
} from "../config-loader.js";
import { PRESENCE_TEMPLATE_KEYS, PRESENCE_TEMPLATE_PATTERN, type DiscordPresenceConfig, type PresenceProfileConfig } from "./types.js";

const SCHEMA_PATH = agentSchemaPath("discord-presence.schema.json");
const TEMPLATE_KEYS = new Set<string>(PRESENCE_TEMPLATE_KEYS);

class DiscordPresenceConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "DiscordPresenceConfigError";
	}
}

// 分层 Schema 允许档位稀疏覆盖，合并后再检查每个档位是否完整。
type LoadedConfig = Omit<DiscordPresenceConfig, "profiles"> & {
	$schema?: string;
	profiles: Record<string, Partial<PresenceProfileConfig>>;
};

export async function loadDiscordPresenceConfig(cwd: string): Promise<DiscordPresenceConfig> {
	const loaded = await loadValidatedMergedConfig(
		CONFIG_DEFINITIONS.discordPresence,
		cwd,
		createError,
		{ partial: loadValidator, complete: loadCompleteValidator },
	);
	const raw = loaded.merged as LoadedConfig;
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
		throw new DiscordPresenceConfigError("application_id is required when Discord presence is enabled.");
	}
	if (!Object.hasOwn(config.profiles, config.profile)) {
		throw new DiscordPresenceConfigError("Selected Discord presence profile does not exist.", { profile: config.profile });
	}
	validateTemplates(config);
	return config;
}

function validateProfiles(
	profiles: Record<string, Partial<PresenceProfileConfig>>,
): asserts profiles is Record<string, PresenceProfileConfig> {
	for (const [name, profile] of Object.entries(profiles)) {
		if (profile.details === undefined || profile.state === undefined || profile.show_elapsed === undefined) {
			throw new DiscordPresenceConfigError("Discord presence profile is incomplete.", { profile: name });
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
				throw new DiscordPresenceConfigError("Discord presence template contains an unknown placeholder.", {
					path: template.path, placeholder,
				});
			}
		}
	}
}

function createError(message: string, details?: Record<string, unknown>): DiscordPresenceConfigError {
	return new DiscordPresenceConfigError(message, details);
}

const loadValidator = createSchemaValidator({ schemaPath: SCHEMA_PATH, label: "discord-presence", createError });
const loadCompleteValidator = createCompleteSchemaValidator({ schemaPath: SCHEMA_PATH, label: "discord-presence", createError });

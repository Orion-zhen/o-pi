import {
	CONFIG_DEFINITIONS,
	agentSchemaPath,
	createCompleteSchemaValidator,
	createSchemaValidator,
	defaultAgentConfigPath,
	loadValidatedMergedConfig,
	mergeConfigValues,
	readDefaultJsoncConfigSync,
} from "../config-loader.js";
import {
	PRESENCE_ACTIVITY_KINDS,
	type DiscordPresenceConfig,
	type PresenceActivityKind,
	type PresenceAssetsConfig,
	type PresenceProfileConfig,
	type PresenceProfileName,
} from "./types.js";

const SCHEMA_PATH = agentSchemaPath("discord-presence.schema.json");
const TEMPLATE_PATTERN = /\{([a-z_]+)\}/gu;
const TEMPLATE_VALUES = new Set([
	"project",
	"model",
	"session",
	"file",
	"language",
	"executable",
	"tool",
	"label",
]);

export class DiscordPresenceConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "DiscordPresenceConfigError";
	}
}

export async function loadDiscordPresenceConfig(cwd: string): Promise<DiscordPresenceConfig> {
	const loaded = await loadValidatedMergedConfig(
		CONFIG_DEFINITIONS.discordPresence,
		cwd,
		createError,
		{ partial: loadValidator, complete: loadCompleteValidator },
	);
	let merged: unknown = {};
	for (const layer of loaded.layers) merged = mergeDiscordPresenceValues(merged, layer.value);
	return materializeConfig(merged as CompleteDiscordPresenceConfig);
}

export function defaultDiscordPresenceConfig(): DiscordPresenceConfig {
	return materializeConfig(readDefaultJsoncConfigSync({
		configPath: defaultAgentConfigPath("discord-presence.jsonc"),
		schemaPath: SCHEMA_PATH,
		label: "discord-presence",
		createError,
	}) as CompleteDiscordPresenceConfig);
}

interface CompleteDiscordPresenceConfig {
	enabled: boolean;
	application_id: string;
	update_interval_ms: number;
	retry_interval_ms: number;
	profile: PresenceProfileName;
	profiles: Record<PresenceProfileName, PresenceProfileConfig>;
	assets: PresenceAssetsConfig;
}

function materializeConfig(raw: CompleteDiscordPresenceConfig): DiscordPresenceConfig {
	const config: DiscordPresenceConfig = {
		enabled: raw.enabled,
		application_id: raw.application_id,
		update_interval_ms: raw.update_interval_ms,
		retry_interval_ms: raw.retry_interval_ms,
		profile: raw.profile,
		profiles: cloneProfiles(raw.profiles),
		assets: {
			large: { ...raw.assets.large },
			small: {
				text: raw.assets.small.text,
				default: raw.assets.small.default,
				activities: { ...raw.assets.small.activities },
				languages: { ...raw.assets.small.languages },
			},
		},
	};
	if (config.enabled && config.application_id.length === 0) {
		throw new DiscordPresenceConfigError("application_id is required when Discord presence is enabled.");
	}
	if (!Object.hasOwn(config.profiles, config.profile)) {
		throw new DiscordPresenceConfigError("Selected Discord presence profile does not exist.", {
			profile: config.profile,
		});
	}
	validateTemplates(config);
	return config;
}

function cloneProfiles(
	profiles: Record<PresenceProfileName, PresenceProfileConfig>,
): Record<PresenceProfileName, PresenceProfileConfig> {
	if (!isRecord(profiles)) throw new DiscordPresenceConfigError("profiles must be an object.");
	const cloned: Record<string, PresenceProfileConfig> = {};
	for (const [name, value] of Object.entries(profiles)) {
		if (!isRecord(value) || !isRecord(value["details"]) || typeof value["state"] !== "string"
			|| typeof value["show_elapsed"] !== "boolean") {
			throw new DiscordPresenceConfigError("Discord presence profile is incomplete.", { profile: name });
		}
		const details: Partial<Record<PresenceActivityKind, string>> = {};
		for (const kind of PRESENCE_ACTIVITY_KINDS) {
			const template = value["details"][kind];
			if (typeof template === "string") details[kind] = template;
		}
		cloned[name] = { details, state: value["state"], show_elapsed: value["show_elapsed"] };
	}
	if (Object.keys(cloned).length === 0) {
		throw new DiscordPresenceConfigError("At least one Discord presence profile is required.");
	}
	return cloned;
}

function validateTemplates(config: DiscordPresenceConfig): void {
	const templates: Array<{ path: string; value: string }> = [
		{ path: "assets.large.text", value: config.assets.large.text },
		{ path: "assets.small.text", value: config.assets.small.text },
	];
	for (const [profileName, profile] of Object.entries(config.profiles)) {
		templates.push({ path: `profiles.${profileName}.state`, value: profile.state });
		for (const [kind, value] of Object.entries(profile.details)) {
			templates.push({ path: `profiles.${profileName}.details.${kind}`, value });
		}
	}
	for (const template of templates) {
		for (const match of template.value.matchAll(TEMPLATE_PATTERN)) {
			const placeholder = match[1];
			if (placeholder !== undefined && !TEMPLATE_VALUES.has(placeholder)) {
				throw new DiscordPresenceConfigError("Discord presence template contains an unknown placeholder.", {
					path: template.path,
					placeholder,
				});
			}
		}
	}
}

/** details 是 profile 的活动订阅集合，因此每个配置层都按整对象替换。 */
function mergeDiscordPresenceValues(base: unknown, overlay: unknown): unknown {
	const merged = mergeConfigValues(base, overlay);
	if (!isRecord(merged) || !isRecord(overlay) || !isRecord(overlay["profiles"])) return merged;
	const mergedProfiles = merged["profiles"];
	if (!isRecord(mergedProfiles)) return merged;
	for (const [name, profile] of Object.entries(overlay["profiles"])) {
		if (!isRecord(profile) || !("details" in profile)) continue;
		const mergedProfile = mergedProfiles[name];
		if (isRecord(mergedProfile)) mergedProfile["details"] = structuredClone(profile["details"]);
	}
	return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createError(message: string, details?: Record<string, unknown>): DiscordPresenceConfigError {
	return new DiscordPresenceConfigError(message, details);
}

const loadValidator = createSchemaValidator({ schemaPath: SCHEMA_PATH, label: "discord-presence", createError });
const loadCompleteValidator = createCompleteSchemaValidator({ schemaPath: SCHEMA_PATH, label: "discord-presence", createError });

export const PRESENCE_PROFILES = ["minimal", "standard", "detailed"] as const;
export type PresenceProfileName = string;

export const PRESENCE_ACTIVITY_KINDS = [
	"idle",
	"thinking",
	"reading",
	"editing",
	"writing",
	"searching",
	"browsing",
	"shell",
	"other_tool",
] as const;
export type PresenceActivityKind = typeof PRESENCE_ACTIVITY_KINDS[number];

export interface PresenceProfileConfig {
	details: Partial<Record<PresenceActivityKind, string>>;
	state: string;
	show_elapsed: boolean;
}

export interface PresenceAssetsConfig {
	large: {
		key: string;
		text: string;
	};
	small: {
		text: string;
		default: string;
		activities: Record<PresenceActivityKind, string>;
		languages: Record<string, string>;
	};
}

export interface DiscordPresenceConfig {
	enabled: boolean;
	application_id: string;
	update_interval_ms: number;
	retry_interval_ms: number;
	profile: PresenceProfileName;
	profiles: Record<PresenceProfileName, PresenceProfileConfig>;
	assets: PresenceAssetsConfig;
}

export interface PresenceActivity {
	kind: PresenceActivityKind;
	tool: string;
	file?: string;
	language?: string;
	languageKey?: string;
	executable?: string;
}

export interface PresenceSession {
	project: string;
	model: string;
	session: string;
	startedAt: number;
}

export interface PresenceTemplateValues {
	project: string;
	model: string;
	session: string;
	file: string;
	language: string;
	executable: string;
	tool: string;
	label: string;
}

export interface DiscordActivityPayload {
	details?: string;
	state?: string;
	startTimestamp?: number;
	largeImageKey?: string;
	largeImageText?: string;
	smallImageKey?: string;
	smallImageText?: string;
	instance: false;
}

export type PresenceConnectionStatus = "disabled" | "disconnected" | "connecting" | "connected";

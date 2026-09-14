export type PresenceActivityKind =
	| "idle"
	| "thinking"
	| "reading"
	| "editing"
	| "writing"
	| "searching"
	| "browsing"
	| "shell"
	| "other_tool";

export interface PresenceProfileConfig {
	details: Partial<Record<PresenceActivityKind, string>>;
	state: string;
	show_elapsed: boolean;
}

interface PresenceAssetsConfig {
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
	profile: string;
	profiles: Record<string, PresenceProfileConfig>;
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

export const PRESENCE_TEMPLATE_KEYS = ["project", "model", "session", "file", "language", "executable", "tool", "label"] as const;
export const PRESENCE_TEMPLATE_PATTERN = /\{([a-z_]+)\}/gu;
export type PresenceTemplateValues = Record<typeof PRESENCE_TEMPLATE_KEYS[number], string>;

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

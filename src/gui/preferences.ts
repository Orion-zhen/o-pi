export interface GuiPreferences {
	theme: "system" | "light" | "dark";
	themeColor: string;
	fonts: { ui: string[]; code: string[] };
	fontSizes: { ui: number; chat: number; code: number };
	sendShortcut: "mod-enter" | "enter";
}

export type GuiConfigDocument = {
	path: string;
	content: string;
	defaults: GuiPreferences;
} & ({ state: "ready"; value: GuiPreferences } | { state: "error"; message: string });

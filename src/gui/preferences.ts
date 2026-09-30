export const materialRegions = ["canvas", "sidebar", "toolbar", "inspector", "composer", "floating", "dialog", "overlay"] as const;
export type MaterialRegion = typeof materialRegions[number];
export interface MaterialSurface { opacity: number; darkOpacity: number; blur: number; saturation: number }
export type GuiMaterials = { enabled: boolean; desktop: boolean } & Record<MaterialRegion, MaterialSurface>;

export interface GuiPreferences {
	theme: "system" | "light" | "dark";
	themeColor: string;
	materials: GuiMaterials;
	fonts: { ui: string[]; code: string[] };
	fontSizes: { ui: number; chat: number; code: number };
	sendShortcut: "mod-enter" | "enter";
	sessionCache: { idleLimit: number; idleMs: number };
	desktopWeb: { enabled: boolean; host: string; port: number };
}

export type GuiConfigDocument = {
	path: string;
	content: string;
	defaults: GuiPreferences;
} & ({ state: "ready"; value: GuiPreferences } | { state: "error"; message: string });

export const moduleConfigIds = ["autoTitle", "bashTool", "fileTools", "webTools", "approvalGate", "subagent", "lsp", "discordPresence", "tui"] as const;
export type ModuleConfigId = typeof moduleConfigIds[number];

export interface ModuleConfigChoice {
	value: string;
	label: string;
}

export interface ModuleConfigField {
	type: "string" | "boolean" | "integer" | "number" | "array";
	title?: string;
	default?: unknown;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
}

export interface ModuleConfigDocument {
	path: string;
	content: string;
	defaults: string;
	options: Record<string, readonly string[]>;
	arrayOptions: Record<string, readonly ModuleConfigChoice[]>;
	fields: Record<string, ModuleConfigField>;
}

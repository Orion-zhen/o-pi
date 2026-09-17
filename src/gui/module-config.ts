export const moduleConfigIds = ["autoTitle", "bashTool", "fileTools", "webTools", "approvalGate", "subagent", "lsp", "discordPresence", "tui", "tools"] as const;
export type ModuleConfigId = typeof moduleConfigIds[number];

export interface ModuleConfigDocument {
	path: string;
	content: string;
	defaults: string;
	projectPath: string | undefined;
}

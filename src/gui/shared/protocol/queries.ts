import { Type, type Static } from "typebox";
import type { FilePreview, WorkspaceEntry, WorkspaceGit } from "../workspace.ts";
import type { GuiConfigDocument } from "../config/preferences.ts";
import type { ToolOutput } from "../messages/types.ts";
import type { ModuleConfigDocument } from "../config/modules.ts";
import type { McpConfigDocument } from "../config/mcp.ts";
import type { GuiLspServers } from "../lsp.ts";
import type { StorageSnapshot } from "../storage.ts";
import type { SessionSearchPage } from "../session-search.ts";
import type { ModelServicesDocument, ModelServiceCatalog } from "../config/model-services.ts";
import { moduleConfigId, object, short } from "./schema.ts";

export const querySchema = Type.Union([
	object({ query: Type.Literal("storage") }),
	object({ query: Type.Literal("searchSessions"), cwd: short, text: Type.String({ minLength: 1, maxLength: 256 }) }),
	object({ query: Type.Literal("continueSessionSearch"), id: short }),
	object({ query: Type.Literal("moduleConfig"), id: moduleConfigId }),
	object({ query: Type.Literal("searchApiKeyAvailable"), config: Type.String({ maxLength: 4096 }) }),
	object({ query: Type.Literal("guiConfig") }),
	object({ query: Type.Literal("mcpConfig") }),
	object({ query: Type.Literal("modelServices") }),
	object({ query: Type.Literal("modelServiceCatalog"), provider: short }),
	object({ query: Type.Literal("startupChangelog") }),
	object({ query: Type.Literal("availableVersion") }),
	object({ query: Type.Literal("image"), id: short }),
	object({ query: Type.Literal("toolOutput"), id: short }),
	object({ query: Type.Literal("directories"), path: short }),
	object({ query: Type.Literal("files"), prefix: short }),
	object({ query: Type.Literal("workspaceFiles"), cwd: short, path: short }),
	object({ query: Type.Literal("workspaceGit"), cwd: short }),
	object({ query: Type.Literal("lspServers"), cwd: short }),
	object({ query: Type.Literal("previewFile"), cwd: short, path: short }),
	object({ query: Type.Literal("complete"), text: short }),
	object({ query: Type.Literal("config"), file: Type.Literal("settings.json") }),
]);
export type GuiQuery = Static<typeof querySchema>;
export type GlobalQuery = Extract<GuiQuery, { query: "guiConfig" | "moduleConfig" | "searchApiKeyAvailable" | "directories" | "startupChangelog" | "availableVersion" | "mcpConfig" | "modelServices" | "storage" | "searchSessions" | "continueSessionSearch" }>;
export type WorkspaceQuery = Extract<GuiQuery, { query: "workspaceFiles" | "workspaceGit" | "previewFile" | "lspServers" }>;
export type SessionQuery = Exclude<GuiQuery, GlobalQuery | WorkspaceQuery>;
export interface GuiQueryResults {
	searchSessions: SessionSearchPage;
	continueSessionSearch: SessionSearchPage;
	storage: StorageSnapshot;
	mcpConfig: McpConfigDocument;
	modelServices: ModelServicesDocument;
	modelServiceCatalog: ModelServiceCatalog;
	moduleConfig: ModuleConfigDocument;
	searchApiKeyAvailable: boolean;
	guiConfig: GuiConfigDocument;
	startupChangelog: GuiChangelog | null;
	availableVersion: string | null;
	image: string;
	toolOutput: ToolOutput;
	directories: GuiDirectories;
	files: string[];
	workspaceFiles: WorkspaceEntry[];
	workspaceGit: WorkspaceGit | null;
	lspServers: GuiLspServers;
	previewFile: FilePreview;
	complete: { value: string; label: string; description?: string }[];
	config: string;
}
export type Query<T extends GuiQuery = GuiQuery> = <Q extends T>(query: Q) => Promise<GuiQueryResults[Q["query"]]>;

export interface GuiChangelog {
	version: string;
	markdown: string;
	collapsed: boolean;
}

export interface GuiDirectories {
	path: string;
	parent: string;
	children: { name: string; path: string }[];
}

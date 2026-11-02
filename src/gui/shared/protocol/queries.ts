import { lit, str, union, type Static } from "@earendil-works/pi-schema";
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

export const querySchema = union([
	object({ query: lit("storage") }),
	object({ query: lit("searchSessions"), cwd: short, text: str({ minLength: 1, maxLength: 256 }) }),
	object({ query: lit("continueSessionSearch"), id: short }),
	object({ query: lit("moduleConfig"), id: moduleConfigId }),
	object({ query: lit("searchApiKeyAvailable"), config: str({ maxLength: 4096 }) }),
	object({ query: lit("guiConfig") }),
	object({ query: lit("mcpConfig") }),
	object({ query: lit("modelServices") }),
	object({ query: lit("modelServiceCatalog"), provider: short }),
	object({ query: lit("startupChangelog") }),
	object({ query: lit("availableVersion") }),
	object({ query: lit("image"), id: short }),
	object({ query: lit("toolOutput"), id: short }),
	object({ query: lit("directories"), path: short }),
	object({ query: lit("files"), prefix: short }),
	object({ query: lit("workspaceFiles"), cwd: short, path: short }),
	object({ query: lit("workspaceGit"), cwd: short }),
	object({ query: lit("lspServers"), cwd: short }),
	object({ query: lit("previewFile"), cwd: short, path: short }),
	object({ query: lit("complete"), text: short }),
	object({ query: lit("config"), file: lit("settings.json") }),
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

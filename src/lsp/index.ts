import { LspManager } from "./manager.js";
import { createLspFileOperations } from "./file-hooks.js";

export { LspClient } from "./client.js";
export { registerLspCommands } from "./commands.js";
export { queryLspDiagnostics, queryLspStatus, type LspDiagnosticsSnapshot, type LspQueryPort } from "./queries.js";
export {
	featureAvailable,
	lspFeatureAdapters,
	lspFeatureDefinitions,
	requestDocumentSymbols,
	requestIncomingCalls,
	requestReferences,
	requestWorkspaceSymbols,
} from "./features/index.js";
export { LspConfigError, defaultLspConfig, loadLspConfig, resolveLspConfigPath } from "./config.js";
export { DiagnosticsLedger, emptySummary, summarizeDiagnostics } from "./diagnostics.js";
export { LspServerRegistry, LspServerRegistryError } from "./registry.js";
export { fileUriToPath, pathToFileUri } from "./uri.js";
export type * from "./types.js";

/** 进程内共享 LSP manager；文件工具和 /lsp 命令通过它观察同一状态。 */
export const lspManager = new LspManager();
export const lspFileOperations = createLspFileOperations(lspManager);

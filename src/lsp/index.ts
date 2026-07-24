import { LspManager } from "./manager.js";
import { createLspFileHooks } from "./file-hooks.js";

export { registerLspCommands } from "./commands.js";
export { LspConfigError, defaultLspConfig, loadLspConfig, resolveLspConfigPath } from "./config.js";
export { DiagnosticsLedger, emptySummary, summarizeDiagnostics } from "./diagnostics.js";
export { LspServerRegistry, LspServerRegistryError } from "./registry.js";
export { fileUriToPath, pathToFileUri } from "./uri.js";
export type * from "./types.js";

/** 进程内共享 LSP manager；文件工具和 /lsp 命令通过它观察同一状态。 */
export const lspManager = new LspManager();
export const lspFileHooks = createLspFileHooks(lspManager);

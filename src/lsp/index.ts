import { LspManager } from "./manager/manager.js";

export { registerLspCommands } from "./adapters/commands.js";
export type { LoadLsp, LspFileOperations, LspMutationInput, LspReadInput } from "./file-operations.js";
export type { LspDiagnosticsSummary } from "./types.js";

/** 进程内共享 LSP manager；文件工具和 /lsp 命令通过它观察同一状态。 */
export const lspManager = new LspManager();

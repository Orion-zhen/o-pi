import { LspManager } from "./manager/manager.ts";

export { registerLspCommands } from "./adapters/commands.ts";
export type { LoadLsp, LspFileOperations, LspMutationInput, LspReadInput } from "./file-operations.ts";
export type { LspDiagnosticsSummary } from "./types.ts";

/** 进程内共享 LSP manager；文件工具和 /lsp 命令通过它观察同一状态。 */
export const lspManager = new LspManager();

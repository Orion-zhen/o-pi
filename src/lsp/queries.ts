import type { LspManager } from "./manager.js";
import type { LspDiagnosticItem, LspStatus } from "./types.js";

export interface LspDiagnosticsSnapshot {
	entries: Array<{
		path: string;
		items: LspDiagnosticItem[];
	}>;
}

export type LspQueryPort = Pick<LspManager, "knownDiagnostics" | "status">;

/** 查询 LSP runtime 状态；返回可序列化 DTO，不启动展示层。 */
export async function queryLspStatus(port: LspQueryPort, root: string): Promise<LspStatus> {
	return port.status(root);
}

/** 查询当前 ledger 中已知 diagnostics；未启动 LSP 时返回空数组。 */
export async function queryLspDiagnostics(
	port: LspQueryPort,
	root: string,
	filePath?: string,
): Promise<LspDiagnosticsSnapshot> {
	return {
		entries: await port.knownDiagnostics(root, filePath),
	};
}

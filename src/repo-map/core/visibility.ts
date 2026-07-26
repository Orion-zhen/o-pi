import type { RepoMapSymbolNode } from "./types.js";

/** 唯一的静态模块公开性判定；不从 signature 或展示文本反推导出。 */
export function isRepoMapSymbolPublic(symbol: RepoMapSymbolNode): boolean {
	return symbol.name !== undefined && symbol.qualifiedName === symbol.name && symbol.exported;
}

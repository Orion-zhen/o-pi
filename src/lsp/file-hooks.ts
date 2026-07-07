import path from "node:path";

import type { FileToolLspHooks, FileToolLspSymbolCandidate, LspDiagnosticsSummary } from "../file-tools/types.js";
import type { LspManager } from "./manager.js";

/** 将 LSP manager 包装为 file-tools 可选 hook；所有异常都在这里吞掉并退化。 */
export function createLspFileHooks(manager: LspManager): FileToolLspHooks {
	return {
		async enhanceRead(input) {
			try {
				return await manager.readEnhancement(
					input.workspaceRoot,
					input.absolutePath,
					input.content,
					{ startLine: input.start_line, endLine: input.end_line },
					{ outline: input.truncated, enclosing: input.partial },
				);
			} catch {
				return undefined;
			}
		},
		async grepSymbols(input) {
			try {
				const hits = await manager.workspaceSymbols(input.workspaceRoot, input.query);
				const candidates: FileToolLspSymbolCandidate[] = [];
				for (const hit of hits) {
					candidates.push({
						path: hit.path,
						start_line: hit.start_line,
						end_line: hit.end_line,
						kind: hit.kind,
						symbol: hit.symbol,
						...(hit.signature !== undefined ? { signature: hit.signature } : {}),
						reason: hit.exact ? "lsp exact symbol" : "lsp symbol",
					});
				}
				return candidates;
			} catch {
				return [];
			}
		},
		async beforeEdit(input) {
			try {
				return await manager.beforeDiagnostics(path.resolve(input.workspaceRoot, input.path));
			} catch {
				return undefined;
			}
		},
		async afterWrite(input) {
			return diagnosticsOrUnavailable(async () => manager.didWrite(input.workspaceRoot, input.absolutePath, input.content));
		},
		async afterEdit(input) {
			return diagnosticsOrUnavailable(async () => manager.didWrite(input.workspaceRoot, input.absolutePath, input.content, input.baseline));
		},
	};
}

async function diagnosticsOrUnavailable(factory: () => Promise<LspDiagnosticsSummary | undefined>): Promise<LspDiagnosticsSummary | undefined> {
	try {
		return await factory();
	} catch {
		return {
			status: "unavailable",
			file_errors: 0,
			file_warnings: 0,
			new_errors: 0,
			new_warnings: 0,
			resolved_errors: 0,
			resolved_warnings: 0,
			baseline: "unknown",
			items: [],
		};
	}
}

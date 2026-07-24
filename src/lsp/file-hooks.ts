import type { FileToolLspHooks, FileToolLspSymbolCandidate, LspDiagnosticsSummary } from "../file-tools/types.js";
import { emptySummary } from "./diagnostics.js";
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
				const hits = await manager.workspaceSymbols({
					root: input.workspaceRoot,
					query: input.query,
					extensions: input.extensions,
					allowedPaths: input.allowedPaths,
					...(input.signal !== undefined ? { signal: input.signal } : {}),
				});
				const candidates: FileToolLspSymbolCandidate[] = [];
				for (const hit of hits) {
					candidates.push({
						path: hit.path,
						start_line: hit.start_line,
						end_line: hit.end_line,
						kind: hit.kind,
						symbol: hit.symbol,
						...(hit.signature !== undefined ? { signature: hit.signature } : {}),
						reason: hit.origin === "reference" ? "lsp reference" : hit.exact ? "lsp exact symbol" : "lsp symbol",
						origin: hit.origin,
					});
				}
				return candidates;
			} catch {
				return [];
			}
		},
		async beforeEdit(input) {
			try {
				return await manager.beforeDiagnostics(input.workspaceRoot, input.absolutePath);
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
		return emptySummary("unavailable");
	}
}

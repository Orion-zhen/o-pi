import { FileChangeType } from "vscode-languageserver-protocol";

import { emptySummary } from "./diagnostics.js";
import type { LspManager, ReadEnhancement } from "./manager.js";
import type { LspDiagnosticSnapshot, LspDiagnosticsSummary, LspSymbolHit } from "./types.js";

export interface LspReadInput {
	readonly workspaceRoot: string;
	readonly filePath: string;
	readonly content: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly truncated: boolean;
	readonly partial: boolean;
}

export interface LspSymbolInput {
	readonly workspaceRoot: string;
	readonly query: string;
	readonly allowedPaths: ReadonlySet<string>;
	readonly signal?: AbortSignal;
}

export interface LspMutationInput {
	readonly workspaceRoot: string;
	readonly filePath: string;
	readonly content: string;
	readonly created: boolean;
	readonly baseline?: LspDiagnosticSnapshot;
}

/** LSP-owned, best-effort operations exposed to composition adapters. */
export interface LspFileOperations {
	read?(input: LspReadInput): Promise<ReadEnhancement | undefined>;
	symbols?(input: LspSymbolInput): Promise<readonly LspSymbolHit[]>;
	beforeEdit?(input: Pick<LspMutationInput, "workspaceRoot" | "filePath">): Promise<LspDiagnosticSnapshot | undefined>;
	afterWrite?(input: LspMutationInput): Promise<LspDiagnosticsSummary | undefined>;
}

export function createLspFileOperations(manager: LspManager): LspFileOperations {
	return {
		async read(input) {
			try {
				return await manager.readEnhancement(
					input.workspaceRoot,
					input.filePath,
					input.content,
					{ startLine: input.startLine, endLine: input.endLine },
					{ outline: input.truncated, enclosing: input.partial },
				);
			} catch {
				return undefined;
			}
		},
		async symbols(input) {
			try {
				return await manager.workspaceSymbols({
					root: input.workspaceRoot,
					query: input.query,
					allowedPaths: input.allowedPaths,
					...(input.signal === undefined ? {} : { signal: input.signal }),
				});
			} catch {
				return [];
			}
		},
		async beforeEdit(input) {
			try {
				return await manager.beforeDiagnostics(input.workspaceRoot, input.filePath);
			} catch {
				return undefined;
			}
		},
		async afterWrite(input) {
			try {
				await manager.didChangeWatchedFile(
					input.workspaceRoot,
					input.filePath,
					input.created ? FileChangeType.Created : FileChangeType.Changed,
				);
			} catch {
				// 文件变更通知是 best-effort，不影响 diagnostics 或已提交写入。
			}
			return diagnosticsOrUnavailable(async () => manager.didWrite(
				input.workspaceRoot,
				input.filePath,
				input.content,
				input.baseline,
			));
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

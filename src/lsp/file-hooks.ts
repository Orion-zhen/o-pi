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
	afterWriteBatch?(inputs: readonly LspMutationInput[]): Promise<readonly (LspDiagnosticsSummary | undefined)[]>;
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
				// 文件变更通知仅为尽力而为，不影响诊断或已提交写入。
			}
			try {
				return await manager.didWrite(input.workspaceRoot, input.filePath, input.content, input.baseline);
			} catch {
				return emptySummary("unavailable");
			}
		},
		async afterWriteBatch(inputs) {
			return await afterWriteBatch(manager, inputs);
		},
	};
}

async function afterWriteBatch(
	manager: LspManager,
	inputs: readonly LspMutationInput[],
): Promise<readonly (LspDiagnosticsSummary | undefined)[]> {
	try {
		await manager.didChangeWatchedFiles(inputs.map((input) => ({
			root: input.workspaceRoot,
			filePath: input.filePath,
			type: input.created ? FileChangeType.Created : FileChangeType.Changed,
		})));
	} catch {
		// 文件变更通知仅为尽力而为，不影响诊断或已提交写入。
	}
	try {
		return await manager.didWriteBatch(inputs.map((input) => ({
			root: input.workspaceRoot,
			filePath: input.filePath,
			text: input.content,
			...(input.baseline === undefined ? {} : { baseline: input.baseline }),
		})));
	} catch {
		return inputs.map(() => emptySummary("unavailable"));
	}
}

import { FileChangeType } from "vscode-languageserver-protocol";

import type { CodeAnalysis } from "../code-index/types.js";
import { emptySummary } from "./diagnostics.js";
import type {
	LspCodeAnalysisInput,
	LspCodeAnalysisPreparationInput,
	LspManager,
	ReadEnhancement,
} from "./manager.js";
import type { LspDiagnosticSnapshot, LspDiagnosticsSummary, LspLineRange } from "./types.js";

export interface LspReadInput {
	readonly workspaceRoot: string;
	readonly filePath: string;
	readonly content: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly truncated: boolean;
	readonly partial: boolean;
}

export interface LspMutationInput {
	readonly workspaceRoot: string;
	readonly filePath: string;
	readonly content: string;
	readonly created: boolean;
	readonly changed_ranges?: readonly LspLineRange[];
	readonly baseline?: LspDiagnosticSnapshot;
}

/** LSP-owned, best-effort operations exposed to composition adapters. */
export interface LspFileOperations {
	read?(input: LspReadInput): Promise<ReadEnhancement | undefined>;
	prepareCodeAnalysis?(input: LspCodeAnalysisPreparationInput): Promise<void>;
	codeAnalysis?(input: LspCodeAnalysisInput): Promise<CodeAnalysis | undefined>;
	beforeMutation?(input: Pick<LspMutationInput, "workspaceRoot" | "filePath">): Promise<LspDiagnosticSnapshot | undefined>;
	afterMutation?(input: LspMutationInput): Promise<LspDiagnosticsSummary | undefined>;
	afterMutationBatch?(inputs: readonly LspMutationInput[]): Promise<readonly (LspDiagnosticsSummary | undefined)[]>;
}

export function createLspFileOperations(manager: LspManager): LspFileOperations {
	return {
		async prepareCodeAnalysis(input) {
			try {
				await manager.prepareCodeAnalysis(input);
			} catch {
				// 预热仅隐藏冷启动延迟；正式分析仍会重新确认可用性。
			}
		},
		async read(input) {
			try {
				return await manager.readEnhancement(
					input.workspaceRoot,
					input.filePath,
					input.content,
					{ startLine: input.startLine, endLine: input.endLine },
					{ outline: input.truncated && !input.partial, enclosing: input.partial },
				);
			} catch {
				return undefined;
			}
		},
		async codeAnalysis(input) {
			try {
				return await manager.codeAnalysis(input);
			} catch {
				return undefined;
			}
		},
		async beforeMutation(input) {
			try {
				return await manager.beforeDiagnostics(input.workspaceRoot, input.filePath);
			} catch {
				return undefined;
			}
		},
		async afterMutation(input) {
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
				return input.changed_ranges === undefined
					? await manager.didWrite(input.workspaceRoot, input.filePath, input.content, input.baseline)
					: await manager.didWrite(input.workspaceRoot, input.filePath, input.content, input.baseline, input.changed_ranges);
			} catch {
				return emptySummary("unavailable");
			}
		},
		async afterMutationBatch(inputs) {
			return await afterMutationBatch(manager, inputs);
		},
	};
}

async function afterMutationBatch(
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
			...(input.changed_ranges === undefined ? {} : { changed_ranges: input.changed_ranges }),
			...(input.baseline === undefined ? {} : { baseline: input.baseline }),
		})));
	} catch {
		return inputs.map(() => emptySummary("unavailable"));
	}
}

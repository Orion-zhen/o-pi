import type { LspManager } from "./manager/manager.ts";
import type { LspMutationBaseline, LspLineRange } from "./types.ts";

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
	readonly baseline?: LspMutationBaseline;
}

/** 管理器直接提供文件增强，不另建转发对象。 */
export type LspFileOperations = Pick<LspManager,
	"read" | "prepareCodeAnalysis" | "codeAnalysis" | "beforeMutation" | "afterMutation" | "afterMutationBatch">;
export type LoadLsp = () => Promise<LspFileOperations>;

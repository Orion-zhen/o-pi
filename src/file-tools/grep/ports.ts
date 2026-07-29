import type { ExistingRef } from "../../filesystem/contracts/path.js";

export type GrepHintOrigin = "lsp-symbol" | "lsp-reference" | "repo-map";

export interface GrepHintRange {
	readonly startLine: number;
	readonly endLine: number;
	readonly startByte?: number;
	readonly endByte?: number;
}

/**
 * 外部系统只提供定位提示。grep 必须把提示映射到本次读取的 live AST unit，
 * 不能直接把这里的元数据变成公开结果。
 */
export interface GrepPositionHint {
	readonly path: string;
	readonly range: GrepHintRange;
	readonly origin: GrepHintOrigin;
	readonly confidence: number;
	readonly contentHash?: string;
	readonly relation?: string;
	readonly hop?: 0 | 1;
	readonly reasons: readonly string[];
}

export interface GrepHintQueryInput {
	readonly root: ExistingRef;
	readonly query: string;
	readonly allowedPaths: readonly string[];
	readonly limit: number;
	readonly relationQuery?: boolean;
	readonly signal?: AbortSignal;
}

export interface GrepHintSource {
	query(input: GrepHintQueryInput): Promise<readonly GrepPositionHint[]>;
}

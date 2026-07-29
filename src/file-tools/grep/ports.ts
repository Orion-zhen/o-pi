import type { ExistingRef } from "../../filesystem/contracts/path.js";

export type GrepExternalOrigin = "lsp-symbol" | "lsp-reference" | "repo-map";

export interface GrepExternalRange {
	readonly startLine: number;
	readonly endLine: number;
	readonly startByte?: number;
	readonly endByte?: number;
}

/** 增强来源返回的最小边界 DTO；grep 内部 lane、tier 和排名对象不得跨过此端口。 */
export interface GrepExternalCandidate {
	readonly path: string;
	readonly range?: GrepExternalRange;
	readonly kind?: string;
	readonly symbol?: string;
	readonly qualifiedSymbol?: string;
	readonly signature?: string;
	readonly origin: GrepExternalOrigin;
	readonly confidence: number;
	readonly contentHash?: string;
	readonly contentVersion?: string;
	readonly relation?: string;
	readonly hop?: 0 | 1 | 2;
	readonly reasons: readonly string[];
}

export interface GrepExternalQueryInput {
	readonly root: ExistingRef;
	readonly query: string;
	readonly allowedPaths: readonly string[];
	readonly limit: number;
	readonly relationQuery?: boolean;
	readonly signal?: AbortSignal;
}

export interface GrepSymbolSource {
	query(input: GrepExternalQueryInput): Promise<readonly GrepExternalCandidate[]>;
}

export interface GrepGraphSource {
	query(input: GrepExternalQueryInput): Promise<readonly GrepExternalCandidate[]>;
}

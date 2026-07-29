import type { DirectoryRef } from "../../filesystem/contracts/path.js";

export interface FindGraphRelatedFile {
	readonly path: string;
	readonly contentHash?: string;
}

export interface FindGraphEdge {
	readonly hop: 1 | 2;
	readonly confidence: number;
	readonly resolution: "semantic" | "syntactic" | "lexical";
	readonly relatedFiles: readonly FindGraphRelatedFile[];
}

/** Find-owned projection of one external graph candidate. */
export interface FindGraphCandidate {
	readonly path: string;
	readonly contentHash?: string;
	readonly confidence: number;
	readonly hop: 0 | 1 | 2;
	readonly reasons: readonly string[];
	readonly relatedEdges: readonly FindGraphEdge[];
}

export interface FindGraphResult {
	readonly root: DirectoryRef;
	readonly candidates: readonly FindGraphCandidate[];
}

export interface FindGraphSource {
	query(input: {
		readonly root: DirectoryRef;
		readonly query: string;
		readonly limit: number;
		readonly signal?: AbortSignal;
	}): Promise<FindGraphResult | undefined>;
}

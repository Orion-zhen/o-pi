import type { DirectoryRef, ExistingRef } from "../../filesystem/contracts/path.js";

export interface GrepSymbolCandidate {
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly kind: string;
	readonly symbol: string;
	readonly signature?: string;
	readonly reason: "lsp symbol" | "lsp exact symbol" | "lsp reference";
	readonly origin?: "workspace-symbol" | "reference";
}

export interface GrepSymbolSource {
	query(input: {
		readonly root: ExistingRef;
		readonly query: string;
		readonly allowedPaths: readonly string[];
		readonly signal?: AbortSignal;
	}): Promise<readonly GrepSymbolCandidate[]>;
}

export interface GrepGraphRange {
	readonly startLine: number;
	readonly endLine: number;
	readonly startByte: number;
	readonly endByte: number;
}

export interface GrepGraphSymbol {
	readonly id: string;
	readonly kind: string;
	readonly name?: string;
	readonly qualifiedName?: string;
	readonly signature?: string;
	readonly range: GrepGraphRange;
}

export interface GrepGraphRelatedFile {
	readonly path: string;
	readonly contentHash?: string;
}

export interface GrepGraphEdge {
	readonly hop: 1 | 2;
	readonly confidence: number;
	readonly resolution: "semantic" | "syntactic" | "lexical";
	readonly relatedFiles: readonly GrepGraphRelatedFile[];
}

export interface GrepGraphCandidate {
	readonly path: string;
	readonly contentHash?: string;
	readonly symbol?: GrepGraphSymbol;
	readonly range?: GrepGraphRange;
	readonly confidence: number;
	readonly hop: 0 | 1 | 2;
	readonly reasons: readonly string[];
	readonly matchedAliases: readonly { readonly term: string; readonly canonical: string }[];
	readonly relatedEdges: readonly GrepGraphEdge[];
}

export interface GrepGraphResult {
	readonly root: DirectoryRef;
	readonly candidates: readonly GrepGraphCandidate[];
}

export interface GrepGraphSource {
	query(input: {
		readonly root: ExistingRef;
		readonly query: string;
		readonly limit: number;
		readonly signal?: AbortSignal;
	}): Promise<GrepGraphResult | undefined>;
}

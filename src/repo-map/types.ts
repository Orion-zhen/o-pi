import type { FileIdentity, SourceRange } from "../code-index/types.js";

export type RepoMapFreshness = "fresh" | "partially_stale" | "stale" | "unavailable";

export interface RepoMapRepositoryNode {
	kind: "repository";
	id: string;
	repositoryRoot: string;
	worktreeRoot: string;
}

export interface RepoMapFileNode extends FileIdentity {
	kind: "file";
	language: string;
}

export interface RepoMapSymbolNode extends SourceRange {
	kind: "symbol";
	id: string;
	fileId: string;
	symbolKind: string;
	name?: string;
	qualifiedName?: string;
	signature?: string;
	definitions: string[];
	references: string[];
	calls: string[];
	imports: string[];
}

export type RepoMapNode = RepoMapRepositoryNode | RepoMapFileNode | RepoMapSymbolNode;

export type RepoMapEdgeKind = "contains" | "imports" | "exports" | "references" | "calls";
export type RepoMapEdgeResolution = "lexical" | "syntactic" | "semantic";
export type RepoMapEdgeSource = "tree-sitter" | "manifest" | "lsp" | "convention";

export interface RepoMapEvidence extends SourceRange {
	path: string;
	textHash?: string;
}

export interface RepoMapEdge {
	from: string;
	to: string;
	kind: RepoMapEdgeKind;
	resolution: RepoMapEdgeResolution;
	source: RepoMapEdgeSource;
	confidence: number;
	lexicalTarget?: string;
	evidence: RepoMapEvidence[];
}

export interface RepoMapMetadata {
	schemaVersion: number;
	mapId: string;
	repositoryRoot: string;
	worktreeRoot: string;
	gitCommonDir: string;
	generation: string;
	createdAt: string;
	updatedAt: string;
	freshness: RepoMapFreshness;
	fileCount: number;
	indexedFileCount: number;
	parsedFileCount: number;
	unsupportedFileCount: number;
	parseErrorFileCount: number;
	symbolCount: number;
	edgeCount: number;
	tooLargeFileCount: number;
	diagnosticCount: number;
	gitRevision?: string;
	configFingerprint: string;
	ignoreFingerprint: string;
	parserFingerprint: string;
}

export type RepoMapFileStatus = "indexed" | "too_large" | "unreadable" | "unstable";

export interface RepoMapFileRecord extends FileIdentity {
	size: number;
	mtimeMs: number;
	status: RepoMapFileStatus;
	contentHash?: string;
}

export interface RepoMapDiagnostic {
	code: string;
	message: string;
	path?: string;
}

export interface RepoMapScanSummary {
	discovered: number;
	indexed: number;
	reused: number;
	hashed: number;
	added: number;
	changed: number;
	removed: number;
	tooLarge: number;
	unreadable: number;
	unstable: number;
	parsed: number;
	unsupported: number;
	parseErrors: number;
	reusedParsed: number;
	symbols: number;
	edges: number;
	skippedDirectories: number;
	diagnostics: number;
}

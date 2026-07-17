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
	visibility?: "public" | "internal";
}

export type RepoMapArchitectureSource = "manifest" | "convention" | "syntactic";

export interface RepoMapPackageNode {
	kind: "package";
	id: string;
	name: string;
	rootPath: string;
	ecosystem: "npm" | "python" | "go" | "cargo" | "repository";
	manifestPath?: string;
	source: RepoMapArchitectureSource;
	confidence: number;
}

export interface RepoMapComponentNode {
	kind: "component";
	id: string;
	name: string;
	rootPath: string;
	packageId: string;
	source: RepoMapArchitectureSource;
	confidence: number;
}

export type RepoMapEntrypointType = "main" | "module" | "bin" | "export" | "script" | "test" | "command" | "tool" | "plugin";

export interface RepoMapEntrypointNode {
	kind: "entrypoint";
	id: string;
	name: string;
	entrypointType: RepoMapEntrypointType;
	packageId?: string;
	fileId?: string;
	declaredTarget?: string;
	source: RepoMapArchitectureSource;
	confidence: number;
}

export type RepoMapArchitectureNode = RepoMapPackageNode | RepoMapComponentNode | RepoMapEntrypointNode;
export type RepoMapNode = RepoMapRepositoryNode | RepoMapFileNode | RepoMapSymbolNode | RepoMapArchitectureNode;

export type RepoMapEdgeKind =
	| "contains"
	| "belongs-to"
	| "imports"
	| "exports"
	| "references"
	| "calls"
	| "declares-entrypoint"
	| "declares-script"
	| "registers-command"
	| "registers-tool"
	| "registers-plugin"
	| "exports-publicly"
	| "re-exports";
export type RepoMapEdgeResolution = "lexical" | "syntactic" | "semantic";
export type RepoMapEdgeSource = "tree-sitter" | "syntax" | "manifest" | "lsp" | "convention";

export interface RepoMapEvidence extends SourceRange {
	path: string;
	textHash?: string;
}

export type RepoMapAliasSource =
	| "file-path"
	| "symbol"
	| "signature"
	| "import-alias"
	| "export-alias"
	| "architecture"
	| "registration"
	| "config-key"
	| "environment"
	| "doc-comment";

/** repository-derived query term. canonical only applies the small fixed abbreviation table. */
export interface RepoMapLexicalAlias {
	term: string;
	canonical: string;
	target: string;
	source: RepoMapAliasSource;
	confidence: number;
	evidence: RepoMapEvidence[];
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
	aliasCount: number;
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

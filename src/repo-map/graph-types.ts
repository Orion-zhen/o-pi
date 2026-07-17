import type { RepoMapEdge, RepoMapEvidence, RepoMapSymbolNode } from "./types.js";

export interface RepoMapImportFact {
	fileId: string;
	specifier: string;
	evidence: RepoMapEvidence;
}

export interface RepoMapSymbolIndex {
	symbols: RepoMapSymbolNode[];
	imports: RepoMapImportFact[];
	diagnostics: Array<{ code: string; message: string; path?: string }>;
	parsedFileCount: number;
	unsupportedFileCount: number;
	parseErrorFileCount: number;
	reusedParsedFileCount: number;
}

export function compareRepoMapEdge(left: RepoMapEdge, right: RepoMapEdge): number {
	return compare(left.kind, right.kind)
		|| compare(left.from, right.from)
		|| compare(left.to, right.to)
		|| compare(left.lexicalTarget ?? "", right.lexicalTarget ?? "")
		|| compare(left.resolution, right.resolution)
		|| compare(left.source, right.source)
		|| left.confidence - right.confidence;
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

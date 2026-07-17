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
	return compareText(left.kind, right.kind)
		|| compareText(left.from, right.from)
		|| compareText(left.to, right.to)
		|| compareText(left.lexicalTarget ?? "", right.lexicalTarget ?? "")
		|| compareText(left.resolution, right.resolution)
		|| compareText(left.source, right.source)
		|| left.confidence - right.confidence;
}

export function coalesceRepoMapEdges(edges: readonly RepoMapEdge[]): RepoMapEdge[] {
	const merged = new Map<string, RepoMapEdge>();
	for (const edge of edges) {
		const key = [edge.kind, edge.from, edge.to, edge.resolution, edge.source, edge.confidence, edge.lexicalTarget ?? ""].join("\0");
		const existing = merged.get(key);
		if (existing === undefined) merged.set(key, { ...edge, evidence: [...edge.evidence] });
		else existing.evidence.push(...edge.evidence);
	}
	return [...merged.values()]
		.map((edge) => ({ ...edge, evidence: uniqueRepoMapEvidence(edge.evidence) }))
		.sort(compareRepoMapEdge);
}

export function uniqueRepoMapEvidence(values: readonly RepoMapEvidence[]): RepoMapEvidence[] {
	return uniqueBy(values, (value) => [value.path, value.startByte, value.endByte, value.textHash ?? ""].join("\0"))
		.sort(compareRepoMapEvidence);
}

export function compareRepoMapEvidence(left: RepoMapEvidence, right: RepoMapEvidence): number {
	return compareText(left.path, right.path)
		|| left.startByte - right.startByte
		|| left.endByte - right.endByte
		|| compareText(left.textHash ?? "", right.textHash ?? "");
}

export function groupBy<T>(values: readonly T[], keyOf: (value: T) => string): ReadonlyMap<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const value of values) {
		const key = keyOf(value);
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [value]);
		else group.push(value);
	}
	return groups;
}

export function uniqueBy<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
	const unique = new Map<string, T>();
	for (const value of values) unique.set(keyOf(value), value);
	return [...unique.values()];
}

export function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

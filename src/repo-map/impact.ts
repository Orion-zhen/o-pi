import type { RepoMapGeneration } from "./storage.js";
import { compareText } from "./graph.js";
import { fileEvidence, symbolEvidence } from "./source.js";
import type { RepoMapEdge, RepoMapEvidence, RepoMapFileRecord, RepoMapSymbolNode } from "./types.js";

export type RepoMapImpactRole = "changed" | "dependent" | "caller" | "test" | "public-api" | "entrypoint" | "component";

export interface RepoMapImpactCandidate {
	path: string;
	contentHash?: string;
	symbol?: string;
	impactReason: string;
	confidence: number;
	graphDistance: 0 | 1 | 2;
	evidence: RepoMapEvidence[];
	role: RepoMapImpactRole;
}

export interface RepoMapImpactResult {
	candidate: true;
	changedPath: string;
	changedSymbols: string[];
	publicApiChanges: string[];
	candidates: RepoMapImpactCandidate[];
}

export interface AnalyzeRepoMapImpactInput {
	before?: RepoMapGeneration;
	after: RepoMapGeneration;
	changedPath: string;
	changedLine?: number;
	maxCandidates?: number;
}

interface RankedCandidate extends RepoMapImpactCandidate {
	priority: number;
}

interface SymbolChange {
	label: string;
	publicLabel?: string;
	before?: RepoMapSymbolNode;
	after?: RepoMapSymbolNode;
}

/** Compare two immutable generations and project a bounded, explainable impact candidate set. */
export function analyzeRepoMapImpact(input: AnalyzeRepoMapImpactInput): RepoMapImpactResult {
	const maxCandidates = Math.max(1, Math.min(24, input.maxCandidates ?? 12));
	const beforeFile = input.before?.files.find((file) => file.path === input.changedPath);
	const afterFile = input.after.files.find((file) => file.path === input.changedPath);
	const changes = changedSymbols(input.before, input.after, input.changedPath, input.changedLine);
	const changedSymbolsResult = changes.map((change) => change.label).slice(0, 16);
	const publicApiChanges = changes.flatMap((change) => change.publicLabel ?? []).slice(0, 12);
	const candidates = new Map<string, RankedCandidate>();
	const currentFilesById = new Map(input.after.files.map((file) => [file.id, file]));
	const afterLookup = graphLookup(input.after);
	const changedFile = afterFile ?? beforeFile;
	if (changedFile !== undefined) addCandidate(candidates, {
		...candidateFile(changedFile),
		impactReason: "directly changed file",
		confidence: 1,
		graphDistance: 0,
		evidence: [fileEvidence(changedFile)],
		role: "changed",
		priority: 1_200,
	});
	for (const change of changes.slice(0, 8)) {
		const symbol = change.after ?? change.before;
		const file = symbol === undefined ? undefined : (currentFilesById.get(symbol.fileId) ?? changedFile);
		if (symbol === undefined || file === undefined) continue;
		addCandidate(candidates, {
			...candidateFile(file),
			symbol: symbolLabel(symbol),
			impactReason: "directly changed symbol",
			confidence: 1,
			graphDistance: 0,
			evidence: [symbolEvidence(file, symbol)],
			role: change.publicLabel === undefined ? "changed" : "public-api",
			priority: change.publicLabel === undefined ? 1_160 : 1_180,
		});
	}

	const seedIds = new Set<string>([
		...(beforeFile === undefined ? [] : [beforeFile.id]),
		...(afterFile === undefined ? [] : [afterFile.id]),
		...changes.flatMap((change) => [change.before?.id, change.after?.id].filter((id): id is string => id !== undefined)),
	]);
	const directAffectedFiles = new Set<string>();
	for (const generation of [input.after, ...(input.before === undefined ? [] : [input.before])]) {
		const lookup = graphLookup(generation);
		for (const edge of generation.edges) {
			if (edge.kind === "calls" && seedIds.has(edge.to)) {
				const candidate = candidateForNode(edge.from, lookup);
				if (candidate !== undefined) {
					directAffectedFiles.add(candidate.file.id);
					addRelationCandidate(candidates, candidate, edge, "direct caller", "caller", 1, 1_080);
				}
			} else if (edge.kind === "references" && seedIds.has(edge.to)) {
				const candidate = candidateForNode(edge.from, lookup);
				if (candidate !== undefined) {
					directAffectedFiles.add(candidate.file.id);
					addRelationCandidate(candidates, candidate, edge, "direct reference", "dependent", 1, 1_040);
				}
			} else if (edge.kind === "imports" && (seedIds.has(edge.to) || edge.to === beforeFile?.id || edge.to === afterFile?.id)) {
				const candidate = candidateForNode(edge.from, lookup);
				if (candidate !== undefined) {
					directAffectedFiles.add(candidate.file.id);
					addRelationCandidate(candidates, candidate, edge, "direct importer", "dependent", 1, 860);
				}
			}
			if (edge.kind === "tests" && seedIds.has(edge.to)) {
				const candidate = candidateForNode(edge.from, lookup);
				if (candidate !== undefined) addRelationCandidate(candidates, candidate, edge, "explicit test relation", "test", 1, 800);
			}
		}
	}

	if (publicApiChanges.length > 0) {
		for (const generation of [input.after, ...(input.before === undefined ? [] : [input.before])]) {
			const lookup = graphLookup(generation);
			for (const edge of generation.edges) {
				if (!(edge.kind === "imports" || edge.kind === "calls" || edge.kind === "references") || !seedIds.has(edge.to)) continue;
				const candidate = candidateForNode(edge.from, lookup);
				if (candidate !== undefined) addRelationCandidate(candidates, candidate, edge, "depends on changed public API", "public-api", 1, 930);
			}
		}
	}

	for (const edge of input.after.edges) {
		if (!directAffectedFiles.has(edge.to) || edge.kind !== "tests") continue;
		const candidate = candidateForNode(edge.from, afterLookup);
		if (candidate !== undefined) addRelationCandidate(candidates, candidate, edge, "test of directly affected dependent", "test", 2, 680);
	}

	const changedFileId = afterFile?.id ?? beforeFile?.id;
	if (changedFileId !== undefined) {
		const knownComponents = new Set(input.after.architecture.filter((node) => node.kind === "component").map((node) => node.id));
		const componentIds = new Set(input.after.edges
			.filter((edge) => edge.kind === "belongs-to" && edge.from === changedFileId && knownComponents.has(edge.to))
			.map((edge) => edge.to));
		for (const edge of input.after.edges) {
			if (edge.kind !== "belongs-to" || !componentIds.has(edge.to) || edge.from === changedFileId) continue;
			const candidate = candidateForNode(edge.from, afterLookup);
			if (candidate !== undefined) addRelationCandidate(candidates, candidate, edge, "same component", "component", 1, 300);
		}
		for (const edge of input.after.edges) {
			if (!seedIds.has(edge.from) && !seedIds.has(edge.to)) continue;
			if (!isEntrypointEdge(edge)) continue;
			const candidate = candidateForNode(edge.from === changedFileId ? edge.to : edge.from, afterLookup)
				?? (afterFile === undefined ? undefined : { file: afterFile });
			if (candidate !== undefined) addRelationCandidate(candidates, candidate, edge, "entrypoint or registration relation", "entrypoint", 1, 700);
		}
	}

	const ranked = [...candidates.values()]
		.sort(compareCandidates)
		.filter((candidate, index, all) => candidate.role !== "component" || all.slice(0, index).filter((item) => item.role === "component").length < 2)
		.slice(0, maxCandidates)
		.map(({ priority: _priority, ...candidate }) => candidate);
	return { candidate: true, changedPath: input.changedPath, changedSymbols: changedSymbolsResult, publicApiChanges, candidates: ranked };
}

function changedSymbols(before: RepoMapGeneration | undefined, after: RepoMapGeneration, changedPath: string, changedLine: number | undefined): SymbolChange[] {
	const beforeFile = before?.files.find((file) => file.path === changedPath);
	const afterFile = after.files.find((file) => file.path === changedPath);
	const oldSymbols = beforeFile === undefined ? [] : before?.symbols.filter((symbol) => symbol.fileId === beforeFile.id) ?? [];
	const newSymbols = afterFile === undefined ? [] : after.symbols.filter((symbol) => symbol.fileId === afterFile.id);
	const oldByKey = new Map(oldSymbols.map((symbol) => [symbolKey(symbol), symbol]));
	const newByKey = new Map(newSymbols.map((symbol) => [symbolKey(symbol), symbol]));
	const result: SymbolChange[] = [];
	for (const key of new Set([...oldByKey.keys(), ...newByKey.keys()])) {
		const oldSymbol = oldByKey.get(key);
		const newSymbol = newByKey.get(key);
		const apiChanged = oldSymbol === undefined
			|| newSymbol === undefined
			|| apiSignature(oldSymbol) !== apiSignature(newSymbol)
			|| oldSymbol.visibility !== newSymbol.visibility;
		const rangeChanged = oldSymbol !== undefined && newSymbol !== undefined && (oldSymbol.startLine !== newSymbol.startLine
			|| oldSymbol.endLine !== newSymbol.endLine
			|| oldSymbol.startByte !== newSymbol.startByte
			|| oldSymbol.endByte !== newSymbol.endByte);
		const containsChangedLine = changedLine !== undefined
			&& [oldSymbol, newSymbol].some((candidate) => candidate !== undefined && candidate.startLine <= changedLine && candidate.endLine >= changedLine);
		if (!apiChanged && !rangeChanged && !containsChangedLine) continue;
		const symbol = newSymbol ?? oldSymbol;
		if (symbol === undefined) continue;
		const action = oldSymbol === undefined ? "added" : newSymbol === undefined ? "removed" : apiChanged ? "changed" : "modified";
		const isPublic = apiChanged && (oldSymbol?.visibility === "public" || newSymbol?.visibility === "public");
		result.push({
			label: `${action} ${symbolLabel(symbol)}`,
			...(isPublic ? { publicLabel: `${action} ${symbolLabel(symbol)}` } : {}),
			...(oldSymbol !== undefined ? { before: oldSymbol } : {}),
			...(newSymbol !== undefined ? { after: newSymbol } : {}),
		});
	}
	return result.sort((left, right) => compareText(left.label, right.label));
}

function graphLookup(generation: RepoMapGeneration): {
	files: ReadonlyMap<string, RepoMapFileRecord>;
	symbols: ReadonlyMap<string, RepoMapSymbolNode>;
	tests: ReadonlyMap<string, RepoMapGeneration["tests"][number]>;
	entrypointFiles: ReadonlyMap<string, string>;
} {
	return {
		files: new Map(generation.files.map((file) => [file.id, file])),
		symbols: new Map(generation.symbols.map((symbol) => [symbol.id, symbol])),
		tests: new Map(generation.tests.map((node) => [node.id, node])),
		entrypointFiles: new Map(generation.architecture.flatMap((node) => node.kind === "entrypoint" && node.fileId !== undefined ? [[node.id, node.fileId] as const] : [])),
	};
}

function candidateForNode(nodeId: string, lookup: ReturnType<typeof graphLookup>): { file: RepoMapFileRecord; symbol?: string } | undefined {
	const direct = lookup.files.get(nodeId);
	if (direct !== undefined) return { file: direct };
	const symbol = lookup.symbols.get(nodeId);
	if (symbol !== undefined) {
		const file = lookup.files.get(symbol.fileId);
		return file === undefined ? undefined : { file, symbol: symbolLabel(symbol) };
	}
	const test = lookup.tests.get(nodeId);
	if (test !== undefined) {
		const file = lookup.files.get(test.fileId);
		return file === undefined ? undefined : { file, ...(test.testKind === "symbol" ? { symbol: test.name } : {}) };
	}
	const entrypointFile = lookup.entrypointFiles.get(nodeId);
	const file = entrypointFile === undefined ? undefined : lookup.files.get(entrypointFile);
	return file === undefined ? undefined : { file };
}

function addRelationCandidate(
	result: Map<string, RankedCandidate>,
	candidate: { file: RepoMapFileRecord; symbol?: string },
	edge: RepoMapEdge,
	reason: string,
	role: RepoMapImpactRole,
	distance: 1 | 2,
	priority: number,
): void {
	addCandidate(result, {
		...candidateFile(candidate.file),
		...(candidate.symbol !== undefined ? { symbol: candidate.symbol } : {}),
		impactReason: reason,
		confidence: edge.confidence,
		graphDistance: distance,
		evidence: edge.evidence,
		role,
		priority,
	});
}

function addCandidate(result: Map<string, RankedCandidate>, candidate: RankedCandidate): void {
	const key = [candidate.path, candidate.role].join("\0");
	const existing = result.get(key);
	if (existing === undefined || compareCandidates(candidate, existing) < 0) result.set(key, candidate);
}

function candidateFile(file: RepoMapFileRecord): Pick<RepoMapImpactCandidate, "path" | "contentHash"> {
	return { path: file.path, ...(file.contentHash !== undefined ? { contentHash: file.contentHash } : {}) };
}

function symbolKey(symbol: RepoMapSymbolNode): string {
	return [symbol.symbolKind, symbol.qualifiedName ?? symbol.name ?? `<${symbol.startByte}>`].join("\0");
}

function symbolLabel(symbol: RepoMapSymbolNode): string {
	return `${symbol.symbolKind} ${symbol.qualifiedName ?? symbol.name ?? "anonymous"}`;
}

function apiSignature(symbol: RepoMapSymbolNode): string | undefined {
	const signature = symbol.signature;
	if (signature === undefined || (symbol.symbolKind !== "function" && symbol.symbolKind !== "method")) return signature;
	const closeParameters = signature.lastIndexOf(")");
	if (closeParameters < 0) return signature;
	const body = signature.indexOf(" {", closeParameters + 1);
	return body < 0 ? signature : signature.slice(0, body).trimEnd();
}

function isEntrypointEdge(edge: RepoMapEdge): boolean {
	return edge.kind.startsWith("registers-") || edge.kind.startsWith("declares-") || edge.kind === "exports-publicly";
}

function compareCandidates(left: RankedCandidate, right: RankedCandidate): number {
	return right.priority - left.priority
		|| left.graphDistance - right.graphDistance
		|| right.confidence - left.confidence
		|| compareText(left.path, right.path)
		|| compareText(left.symbol ?? "", right.symbol ?? "");
}

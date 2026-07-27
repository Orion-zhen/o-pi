import type { RepoMapGeneration } from "../storage/storage.js";
import { compareText } from "../core/graph.js";
import { fileEvidence, symbolEvidence } from "../core/source.js";
import type {
	RepoMapEdge,
	RepoMapEdgeKind,
	RepoMapEvidence,
	RepoMapFileRecord,
	RepoMapSymbolNode,
} from "../core/types.js";

export type RepoMapImpactRole = "changed" | "dependent" | "caller" | "test" | "public_api" | "entrypoint" | "component";

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

interface GraphLookup {
	filesById: ReadonlyMap<string, RepoMapFileRecord>;
	filesByPath: ReadonlyMap<string, RepoMapFileRecord>;
	symbolsById: ReadonlyMap<string, RepoMapSymbolNode>;
	symbolsByFile: ReadonlyMap<string, readonly RepoMapSymbolNode[]>;
	testsById: ReadonlyMap<string, RepoMapGeneration["tests"][number]>;
	entrypointFiles: ReadonlyMap<string, string>;
	componentIds: ReadonlySet<string>;
}

interface ImpactEdgeLookup {
	directToSeeds: readonly RepoMapEdge[];
	testsByTarget: readonly RepoMapEdge[];
	componentMemberships: readonly RepoMapEdge[];
	entrypointRelations: readonly RepoMapEdge[];
}

type DirectRelationKind = Extract<RepoMapEdgeKind, "calls" | "references" | "imports" | "tests">;
type PublicApiRelationKind = Exclude<DirectRelationKind, "tests">;

/** Compare two immutable generations and project a bounded, explainable impact candidate set. */
export function analyzeRepoMapImpact(input: AnalyzeRepoMapImpactInput): RepoMapImpactResult {
	const maxCandidates = Math.max(1, Math.min(24, input.maxCandidates ?? 12));
	const beforeLookup = input.before === undefined ? undefined : graphLookup(input.before);
	const afterLookup = graphLookup(input.after);
	const beforeFile = beforeLookup?.filesByPath.get(input.changedPath);
	const afterFile = afterLookup.filesByPath.get(input.changedPath);
	const changes = changedSymbols(beforeLookup, afterLookup, beforeFile, afterFile, input.changedLine);
	const changedSymbolsResult = changes.map((change) => change.label).slice(0, 16);
	const publicApiChanges = changes.flatMap((change) => change.publicLabel ?? []).slice(0, 12);
	const candidates = new Map<string, RankedCandidate>();
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
		const file = symbol === undefined ? undefined : (afterLookup.filesById.get(symbol.fileId) ?? changedFile);
		if (symbol === undefined || file === undefined) continue;
		addCandidate(candidates, {
			...candidateFile(file),
			symbol: symbolLabel(symbol),
			impactReason: "directly changed symbol",
			confidence: 1,
			graphDistance: 0,
			evidence: [symbolEvidence(file, symbol)],
			role: change.publicLabel === undefined ? "changed" : "public_api",
			priority: change.publicLabel === undefined ? 1_160 : 1_180,
		});
	}

	const seedIds = new Set<string>([
		...(beforeFile === undefined ? [] : [beforeFile.id]),
		...(afterFile === undefined ? [] : [afterFile.id]),
		...changes.flatMap((change) => [change.before?.id, change.after?.id].filter((id): id is string => id !== undefined)),
	]);
	const beforeEdges = input.before === undefined || beforeLookup === undefined
		? undefined
		: impactEdgeLookup(input.before, beforeLookup.componentIds, seedIds, false);
	const afterEdges = impactEdgeLookup(input.after, afterLookup.componentIds, seedIds, true);
	const indexedGenerations = [
		{ nodes: afterLookup, edges: afterEdges },
		...(beforeLookup === undefined || beforeEdges === undefined ? [] : [{ nodes: beforeLookup, edges: beforeEdges }]),
	];
	const directAffectedFiles = new Set<string>();
	for (const indexed of indexedGenerations) {
		for (const edge of indexed.edges.directToSeeds) {
			const lookup = indexed.nodes;
			if (edge.kind === "calls") {
				const candidate = candidateForNode(edge.from, lookup);
				if (candidate !== undefined) {
					directAffectedFiles.add(candidate.file.id);
					addRelationCandidate(candidates, candidate, edge, "direct caller", "caller", 1, 1_080);
				}
			} else if (edge.kind === "references") {
				const candidate = candidateForNode(edge.from, lookup);
				if (candidate !== undefined) {
					directAffectedFiles.add(candidate.file.id);
					addRelationCandidate(candidates, candidate, edge, "direct reference", "dependent", 1, 1_040);
				}
			} else if (edge.kind === "imports") {
				const candidate = candidateForNode(edge.from, lookup);
				if (candidate !== undefined) {
					directAffectedFiles.add(candidate.file.id);
					addRelationCandidate(candidates, candidate, edge, "direct importer", "dependent", 1, 860);
				}
			} else {
				const candidate = candidateForNode(edge.from, lookup);
				if (candidate !== undefined) addRelationCandidate(candidates, candidate, edge, "explicit test relation", "test", 1, 800);
			}
		}
	}

	if (publicApiChanges.length > 0) {
		for (const indexed of indexedGenerations) {
			for (const edge of indexed.edges.directToSeeds) {
				if (!isPublicApiRelationKind(edge.kind)) continue;
				const candidate = candidateForNode(edge.from, indexed.nodes);
				if (candidate !== undefined) addRelationCandidate(candidates, candidate, edge, "depends on changed public API", "public_api", 1, 930);
			}
		}
	}

	for (const edge of afterEdges.testsByTarget) {
		if (!directAffectedFiles.has(edge.to)) continue;
		const candidate = candidateForNode(edge.from, afterLookup);
		if (candidate !== undefined) addRelationCandidate(candidates, candidate, edge, "test of directly affected dependent", "test", 2, 680);
	}

	const changedFileId = afterFile?.id ?? beforeFile?.id;
	if (changedFileId !== undefined) {
		const componentIds = new Set(afterEdges.componentMemberships
			.filter((edge) => edge.from === changedFileId)
			.map((edge) => edge.to));
		const componentCandidates = new Map<string, RankedCandidate>();
		for (const edge of afterEdges.componentMemberships) {
			if (!componentIds.has(edge.to) || edge.from === changedFileId) continue;
			const candidate = candidateForNode(edge.from, afterLookup);
			if (candidate !== undefined) {
				addRelationCandidate(componentCandidates, candidate, edge, "same component", "component", 1, 300);
				limitCandidates(componentCandidates, 2);
			}
		}
		for (const candidate of componentCandidates.values()) addCandidate(candidates, candidate);
		for (const edge of afterEdges.entrypointRelations) {
			const candidate = candidateForNode(edge.from === changedFileId ? edge.to : edge.from, afterLookup)
				?? (afterFile === undefined ? undefined : { file: afterFile });
			if (candidate !== undefined) addRelationCandidate(candidates, candidate, edge, "entrypoint or registration relation", "entrypoint", 1, 700);
		}
	}

	const ranked: RepoMapImpactCandidate[] = [];
	let componentCount = 0;
	for (const { priority: _priority, ...candidate } of [...candidates.values()].sort(compareCandidates)) {
		if (candidate.role === "component") {
			if (componentCount >= 2) continue;
			componentCount += 1;
		}
		ranked.push(candidate);
		if (ranked.length >= maxCandidates) break;
	}
	return { candidate: true, changedPath: input.changedPath, changedSymbols: changedSymbolsResult, publicApiChanges, candidates: ranked };
}

function changedSymbols(
	before: GraphLookup | undefined,
	after: GraphLookup,
	beforeFile: RepoMapFileRecord | undefined,
	afterFile: RepoMapFileRecord | undefined,
	changedLine: number | undefined,
): SymbolChange[] {
	const oldSymbols = before === undefined || beforeFile === undefined ? [] : before.symbolsByFile.get(beforeFile.id) ?? [];
	const newSymbols = afterFile === undefined ? [] : after.symbolsByFile.get(afterFile.id) ?? [];
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

function graphLookup(generation: RepoMapGeneration): GraphLookup {
	const filesById = new Map(generation.files.map((file) => [file.id, file]));
	const filesByPath = new Map(generation.files.map((file) => [file.path, file]));
	const symbolsById = new Map(generation.symbols.map((symbol) => [symbol.id, symbol]));
	const symbolsByFile = new Map<string, RepoMapSymbolNode[]>();
	for (const symbol of generation.symbols) appendValue(symbolsByFile, symbol.fileId, symbol);
	const testsById = new Map(generation.tests.map((node) => [node.id, node]));
	const entrypointFiles = new Map<string, string>();
	const componentIds = new Set<string>();
	for (const node of generation.architecture) {
		if (node.kind === "component") componentIds.add(node.id);
		else if (node.kind === "entrypoint" && node.fileId !== undefined) entrypointFiles.set(node.id, node.fileId);
	}
	return { filesById, filesByPath, symbolsById, symbolsByFile, testsById, entrypointFiles, componentIds };
}

function impactEdgeLookup(
	generation: RepoMapGeneration,
	componentIds: ReadonlySet<string>,
	seedIds: ReadonlySet<string>,
	includeStructuralImpact: boolean,
): ImpactEdgeLookup {
	const directToSeeds: RepoMapEdge[] = [];
	const testsByTarget: RepoMapEdge[] = [];
	const componentMemberships: RepoMapEdge[] = [];
	const entrypointRelations: RepoMapEdge[] = [];
	for (const edge of generation.edges) {
		if (isDirectRelationKind(edge.kind) && seedIds.has(edge.to)) directToSeeds.push(edge);
		if (!includeStructuralImpact) continue;
		if (edge.kind === "tests") testsByTarget.push(edge);
		if (edge.kind === "belongs-to" && componentIds.has(edge.to)) componentMemberships.push(edge);
		if (isEntrypointEdge(edge) && (seedIds.has(edge.from) || seedIds.has(edge.to))) entrypointRelations.push(edge);
	}
	return { directToSeeds, testsByTarget, componentMemberships, entrypointRelations };
}

function isDirectRelationKind(kind: RepoMapEdgeKind): kind is DirectRelationKind {
	return kind === "calls" || kind === "references" || kind === "imports" || kind === "tests";
}

function isPublicApiRelationKind(kind: RepoMapEdgeKind): kind is PublicApiRelationKind {
	return kind === "calls" || kind === "references" || kind === "imports";
}

function appendValue<T>(groups: Map<string, T[]>, key: string, value: T): void {
	const existing = groups.get(key);
	if (existing === undefined) groups.set(key, [value]);
	else existing.push(value);
}

function candidateForNode(nodeId: string, lookup: GraphLookup): { file: RepoMapFileRecord; symbol?: string } | undefined {
	const direct = lookup.filesById.get(nodeId);
	if (direct !== undefined) return { file: direct };
	const symbol = lookup.symbolsById.get(nodeId);
	if (symbol !== undefined) {
		const file = lookup.filesById.get(symbol.fileId);
		return file === undefined ? undefined : { file, symbol: symbolLabel(symbol) };
	}
	const test = lookup.testsById.get(nodeId);
	if (test !== undefined) {
		const file = lookup.filesById.get(test.fileId);
		return file === undefined ? undefined : { file, ...(test.testKind === "symbol" ? { symbol: test.name } : {}) };
	}
	const entrypointFile = lookup.entrypointFiles.get(nodeId);
	const file = entrypointFile === undefined ? undefined : lookup.filesById.get(entrypointFile);
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
	const key = candidateKey(candidate);
	const existing = result.get(key);
	if (existing === undefined || compareCandidates(candidate, existing) < 0) result.set(key, candidate);
}

function limitCandidates(candidates: Map<string, RankedCandidate>, limit: number): void {
	if (candidates.size <= limit) return;
	let worst: RankedCandidate | undefined;
	for (const candidate of candidates.values()) {
		if (worst === undefined || compareCandidates(candidate, worst) > 0) worst = candidate;
	}
	if (worst !== undefined) candidates.delete(candidateKey(worst));
}

function candidateKey(candidate: Pick<RepoMapImpactCandidate, "path" | "role">): string {
	return [candidate.path, candidate.role].join("\0");
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

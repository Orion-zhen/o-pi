import path from "node:path";

import type { SourceRange } from "../code-index/types.js";
import { canonicalLexicalTerm, lexicalTerms } from "./lexical-indexer.js";
import type { RepoMapGeneration } from "./storage.js";
import type {
	RepoMapArchitectureNode,
	RepoMapEdge,
	RepoMapEvidence,
	RepoMapFileRecord,
	RepoMapLexicalAlias,
	RepoMapSymbolNode,
} from "./types.js";

export type RepoMapMatchReason =
	| "exact path"
	| "exact filename"
	| "path match"
	| "exact qualified symbol"
	| "exact symbol"
	| "short symbol"
	| "signature"
	| "alias"
	| "definition"
	| "export"
	| "reference"
	| "caller"
	| "callee"
	| "import"
	| "package"
	| "component"
	| "entrypoint"
	| "registration"
	| "public api";

export interface RepoMapRelatedEdge {
	kind: RepoMapEdge["kind"];
	from: string;
	to: string;
	confidence: number;
	resolution: RepoMapEdge["resolution"];
	source: RepoMapEdge["source"];
	hop: 1 | 2;
	evidence: RepoMapEvidence[];
	relatedFiles: Array<{ path: string; contentHash?: string }>;
}

export interface RepoMapAliasMatch {
	term: string;
	canonical: string;
	source: RepoMapLexicalAlias["source"];
	confidence: number;
	evidence: RepoMapEvidence[];
}

export interface RepoMapQueryCandidate {
	path: string;
	fileId: string;
	contentHash?: string;
	symbol?: {
		id: string;
		kind: string;
		name?: string;
		qualifiedName?: string;
		signature?: string;
		range: SourceRange;
	};
	range?: SourceRange;
	score: number;
	confidence: number;
	hop: 0 | 1 | 2;
	reasons: RepoMapMatchReason[];
	matchedAliases: RepoMapAliasMatch[];
	relatedEdges: RepoMapRelatedEdge[];
}

export interface RepoMapQueryResult {
	root: string;
	explanation: {
		queryTerms: string[];
		expandedTerms: string[];
		seedCount: number;
		maxHop: 2;
	};
	candidates: RepoMapQueryCandidate[];
}

interface SeedMatch {
	symbol: RepoMapSymbolNode;
	score: number;
	confidence: number;
	reasons: RepoMapMatchReason[];
	aliases: RepoMapAliasMatch[];
}

interface QuerySeed {
	nodeId: string;
	score: number;
	confidence: number;
	reasons: RepoMapMatchReason[];
	aliases: RepoMapAliasMatch[];
}

interface TraversalState extends QuerySeed {
	hop: 0 | 1 | 2;
	edges: RepoMapRelatedEdge[];
	canPropagate: boolean;
}

const EDGE_WEIGHT: Record<RepoMapEdge["kind"], number> = {
	contains: 0.45,
	"belongs-to": 0.7,
	imports: 0.8,
	exports: 0.94,
	references: 0.76,
	calls: 0.88,
	"declares-entrypoint": 0.9,
	"declares-script": 0.88,
	"registers-command": 0.97,
	"registers-tool": 0.97,
	"registers-plugin": 0.97,
	"exports-publicly": 0.98,
	"re-exports": 0.95,
};
const RESOLUTION_WEIGHT: Record<RepoMapEdge["resolution"], number> = { semantic: 1, syntactic: 0.96, lexical: 0.72 };
const MAX_NEIGHBORS = 12;
const HUB_DEGREE = 12;

/** Immutable generation lookup. Source contents are never returned from this index. */
export class RepoMapQueryIndex {
	readonly #generation: RepoMapGeneration;
	readonly #filesById: ReadonlyMap<string, RepoMapFileRecord>;
	readonly #symbolsById: ReadonlyMap<string, RepoMapSymbolNode>;
	readonly #architectureById: ReadonlyMap<string, RepoMapArchitectureNode>;
	readonly #outgoing: ReadonlyMap<string, RepoMapEdge[]>;
	readonly #incoming: ReadonlyMap<string, RepoMapEdge[]>;
	readonly #aliasesByTerm: ReadonlyMap<string, RepoMapLexicalAlias[]>;
	readonly #aliasesByCanonical: ReadonlyMap<string, RepoMapLexicalAlias[]>;

	constructor(generation: RepoMapGeneration) {
		this.#generation = generation;
		this.#filesById = new Map(generation.files.map((file) => [file.id, file]));
		this.#symbolsById = new Map(generation.symbols.map((symbol) => [symbol.id, symbol]));
		this.#architectureById = new Map(generation.architecture.map((node) => [node.id, node]));
		this.#outgoing = groupEdges(generation.edges, (edge) => edge.from);
		this.#incoming = groupEdges(generation.edges, (edge) => edge.to);
		this.#aliasesByTerm = groupAliases(generation.aliases, (alias) => alias.term);
		this.#aliasesByCanonical = groupAliases(generation.aliases, (alias) => alias.canonical);
	}

	findFiles(query: string): RepoMapQueryCandidate[] {
		const normalized = normalize(query);
		const basename = path.posix.basename(normalized);
		const result: RepoMapQueryCandidate[] = [];
		for (const file of this.#generation.files) {
			const filePath = normalize(file.path);
			const fileBasename = path.posix.basename(filePath);
			let score = 0;
			let reason: RepoMapMatchReason | undefined;
			if (filePath === normalized) {
				score = 1_000;
				reason = "exact path";
			} else if (fileBasename === basename || fileBasename === normalized) {
				score = 920;
				reason = "exact filename";
			} else if (normalized.length > 0 && (filePath.includes(normalized) || fileBasename.includes(normalized))) {
				score = 620;
				reason = "path match";
			}
			if (reason !== undefined) result.push(fileCandidate(file, score, score >= 900 ? 1 : 0.75, [reason]));
		}
		return result.sort(compareCandidates);
	}

	findSymbols(query: string): RepoMapQueryCandidate[] {
		return this.#seedSymbols(query).flatMap((seed) => {
			const file = this.#filesById.get(seed.symbol.fileId);
			return file === undefined ? [] : [symbolCandidate(file, seed.symbol, seed.score, seed.confidence, seed.reasons, [], seed.aliases)];
		}).sort(compareCandidates);
	}

	definitions(query: string): RepoMapQueryCandidate[] {
		return this.#seedSymbols(query).flatMap((seed) => this.#definitionCandidate(seed)).sort(compareCandidates);
	}

	references(query: string): RepoMapQueryCandidate[] {
		return this.#incomingSymbolRelations(query, "references", "reference", 430);
	}

	callers(query: string): RepoMapQueryCandidate[] {
		return this.#incomingSymbolRelations(query, "calls", "caller", 460);
	}

	callees(query: string): RepoMapQueryCandidate[] {
		return this.#outgoingSymbolRelations(query, "calls", "callee", 410);
	}

	imports(query: string): RepoMapQueryCandidate[] {
		const result: RepoMapQueryCandidate[] = [];
		for (const seed of this.#seedSymbols(query)) {
			for (const edge of [...(this.#outgoing.get(seed.symbol.fileId) ?? []), ...(this.#incoming.get(seed.symbol.fileId) ?? [])]) {
				if (edge.kind !== "imports") continue;
				const relatedFileId = edge.from === seed.symbol.fileId ? edge.to : edge.from;
				const file = this.#filesById.get(relatedFileId);
				if (file === undefined) continue;
				result.push(fileCandidate(file, 260, edge.confidence, ["import"], [this.#edgeDetails(edge, 1)], seed.aliases, 1));
			}
		}
		return coalesceCandidates(result);
	}

	architecture(query: string): RepoMapQueryCandidate[] {
		const result: RepoMapQueryCandidate[] = [];
		for (const seed of this.#architectureSeeds(query)) result.push(...this.#candidatesForNode(seed.nodeId, { ...seed, hop: 0, edges: [], canPropagate: true }));
		return coalesceCandidates(result);
	}

	/** exact/alias seeds -> at most two graph hops -> diversity-aware budget packing. */
	candidates(query: string, limit = 100): RepoMapQueryResult {
		const terms = lexicalTerms(query);
		const expandedTerms = [...new Set(terms.map(canonicalLexicalTerm))];
		const seeds = this.#querySeeds(query);
		const direct = coalesceCandidates([
			...this.findFiles(query),
			...this.findSymbols(query),
			...this.definitions(query),
			...this.architecture(query),
			...this.#aliasCandidates(query),
		]);
		const traversed = this.#traverse(seeds);
		const combined = coalesceCandidates([...direct, ...traversed]);
		return {
			root: this.#generation.metadata.repositoryRoot,
			explanation: { queryTerms: terms, expandedTerms, seedCount: seeds.length, maxHop: 2 },
			candidates: this.#packDiverse(combined, Math.max(0, limit)),
		};
	}

	#querySeeds(query: string): QuerySeed[] {
		const result: QuerySeed[] = [];
		for (const candidate of this.findFiles(query)) {
			if (candidate.score >= 900) result.push({ nodeId: candidate.fileId, score: candidate.score, confidence: candidate.confidence, reasons: candidate.reasons, aliases: [] });
		}
		for (const seed of this.#seedSymbols(query)) {
			result.push({ nodeId: seed.symbol.id, score: seed.score, confidence: seed.confidence, reasons: seed.reasons, aliases: seed.aliases });
			result.push({ nodeId: seed.symbol.fileId, score: seed.score - 60, confidence: seed.confidence, reasons: seed.reasons, aliases: seed.aliases });
		}
		result.push(...this.#architectureSeeds(query), ...this.#aliasSeeds(query));
		return coalesceSeeds(result).slice(0, 64);
	}

	#seedSymbols(query: string): SeedMatch[] {
		const queryLower = query.toLocaleLowerCase();
		const shortQuery = lastSegment(queryLower);
		const result: SeedMatch[] = [];
		for (const symbol of this.#generation.symbols) {
			const name = symbol.name?.toLocaleLowerCase();
			const qualifiedName = symbol.qualifiedName?.toLocaleLowerCase();
			const signature = symbol.signature?.toLocaleLowerCase();
			if (qualifiedName === queryLower) {
				result.push({ symbol, score: 980, confidence: 1, reasons: ["exact qualified symbol", ...(symbol.visibility === "public" ? ["public api" as const] : [])], aliases: [] });
			} else if (name === queryLower) {
				result.push({ symbol, score: 930, confidence: 1, reasons: ["exact symbol", ...(symbol.visibility === "public" ? ["public api" as const] : [])], aliases: [] });
			} else if (qualifiedName !== undefined && lastSegment(qualifiedName) === shortQuery) {
				result.push({ symbol, score: 880, confidence: 0.92, reasons: ["short symbol"], aliases: [] });
			} else if (queryLower.length >= 3 && signature?.includes(queryLower) === true) {
				result.push({ symbol, score: 680, confidence: 0.75, reasons: ["signature"], aliases: [] });
			}
		}
		for (const seed of this.#aliasSeeds(query)) {
			const symbol = this.#symbolsById.get(seed.nodeId);
			if (symbol !== undefined) result.push({ symbol, score: seed.score, confidence: seed.confidence, reasons: seed.reasons, aliases: seed.aliases });
		}
		return coalesceSymbolSeeds(result);
	}

	#architectureSeeds(query: string): QuerySeed[] {
		const normalized = normalize(query);
		if (normalized.length === 0) return [];
		const result: QuerySeed[] = [];
		for (const node of this.#architectureById.values()) {
			const fields = node.kind === "entrypoint" ? [node.name, node.entrypointType, node.declaredTarget] : [node.name, node.rootPath];
			const exact = fields.some((field) => field !== undefined && normalize(field) === normalized);
			const partial = fields.some((field) => field !== undefined && normalize(field).includes(normalized));
			if (!exact && !partial) continue;
			const reason = architectureReason(node);
			result.push({ nodeId: node.id, score: (exact ? 820 : 560) + (node.kind === "entrypoint" ? 80 : 0), confidence: node.confidence, reasons: [reason], aliases: [] });
		}
		return result;
	}

	#aliasSeeds(query: string): QuerySeed[] {
		const terms = lexicalTerms(query);
		const queryKeys = new Set([...terms, ...terms.map(canonicalLexicalTerm)]);
		const phrase = terms.find((term) => term.includes(" "));
		const canonicalPhrase = phrase === undefined ? undefined : canonicalLexicalTerm(phrase);
		const matches = new Map<string, RepoMapLexicalAlias>();
		for (const key of queryKeys) {
			for (const alias of [...(this.#aliasesByTerm.get(key) ?? []), ...(this.#aliasesByCanonical.get(key) ?? [])]) {
				matches.set(aliasKey(alias), alias);
			}
		}
		const result: QuerySeed[] = [];
		for (const alias of matches.values()) {
			const frequency = Math.max(this.#aliasesByTerm.get(alias.term)?.length ?? 0, this.#aliasesByCanonical.get(alias.canonical)?.length ?? 0);
			const frequencyPenalty = Math.min(260, Math.max(0, frequency - 1) * 12);
			const phraseMatch = phrase !== undefined && (alias.term === phrase || alias.canonical === canonicalPhrase);
			const phraseAdjustment = phrase === undefined ? 0 : phraseMatch ? 220 : -140;
			result.push({
				nodeId: alias.target,
				score: Math.max(300, Math.round(760 * alias.confidence) + phraseAdjustment - frequencyPenalty),
				confidence: alias.confidence,
				reasons: ["alias"],
				aliases: [aliasMatch(alias)],
			});
		}
		return coalesceSeeds(result).slice(0, 48);
	}

	#aliasCandidates(query: string): RepoMapQueryCandidate[] {
		return this.#aliasSeeds(query).flatMap((seed) => this.#candidatesForNode(seed.nodeId, { ...seed, hop: 0, edges: [], canPropagate: true }));
	}

	#traverse(seeds: readonly QuerySeed[]): RepoMapQueryCandidate[] {
		const result: RepoMapQueryCandidate[] = [];
		const queue: TraversalState[] = seeds.map((seed) => ({ ...seed, hop: 0, edges: [], canPropagate: true }));
		const best = new Map<string, number>();
		while (queue.length > 0) {
			const state = queue.shift();
			if (state === undefined || state.hop >= 2 || !state.canPropagate || state.nodeId.startsWith("repository:")) continue;
			const degree = this.#degree(state.nodeId);
			const edges = this.#neighbors(state.nodeId)
				.filter((edge) => edge.confidence >= 0.4 && !(edge.kind === "contains" && (edge.from.startsWith("repository:") || edge.to.startsWith("repository:"))))
				.sort((left, right) => propagationWeight(right, degree) - propagationWeight(left, degree) || compareEdge(left, right))
				.slice(0, degree > HUB_DEGREE ? 5 : MAX_NEIGHBORS);
			for (const edge of edges) {
				const target = edge.from === state.nodeId ? edge.to : edge.from;
				if (!this.#isKnownNode(target)) continue;
				const hop = (state.hop + 1) as 1 | 2;
				const weight = propagationWeight(edge, degree);
				const score = Math.round(state.score * weight * 0.78);
				const confidence = state.confidence * edge.confidence * RESOLUTION_WEIGHT[edge.resolution];
				if (score < 120 || confidence < 0.18) continue;
				const key = `${target}:${hop}`;
				if ((best.get(key) ?? -1) >= score) continue;
				best.set(key, score);
				const details = this.#edgeDetails(edge, hop);
				const next: TraversalState = {
					nodeId: target,
					score,
					confidence,
					reasons: [...state.reasons, relationReason(edge, state.nodeId)],
					aliases: state.aliases,
					hop,
					edges: [...state.edges, details],
					canPropagate: hop < 2
						&& edge.confidence >= 0.65
						&& !(edge.resolution === "lexical" && edge.confidence < 0.8)
						&& !(edge.kind === "belongs-to" && this.#architectureById.get(target)?.kind !== "entrypoint"),
				};
				result.push(...this.#candidatesForNode(target, next));
				if (next.canPropagate) queue.push(next);
			}
		}
		return result;
	}

	#candidatesForNode(nodeId: string, state: TraversalState): RepoMapQueryCandidate[] {
		const file = this.#filesById.get(nodeId);
		if (file !== undefined) return [fileCandidate(file, state.score, state.confidence, state.reasons, state.edges, state.aliases, state.hop)];
		const symbol = this.#symbolsById.get(nodeId);
		if (symbol !== undefined) {
			const symbolFile = this.#filesById.get(symbol.fileId);
			return symbolFile === undefined ? [] : [symbolCandidate(symbolFile, symbol, state.score, state.confidence, state.reasons, state.edges, state.aliases, state.hop)];
		}
		const architecture = this.#architectureById.get(nodeId);
		if (architecture === undefined) return [];
		if (state.hop > 0 && architecture.kind !== "entrypoint") return [];
		const fileIds = new Set<string>();
		if (architecture.kind === "entrypoint" && architecture.fileId !== undefined) fileIds.add(architecture.fileId);
		for (const edge of [...(this.#outgoing.get(nodeId) ?? []), ...(this.#incoming.get(nodeId) ?? [])]) {
			const other = edge.from === nodeId ? edge.to : edge.from;
			if (this.#filesById.has(other)) fileIds.add(other);
			const relatedSymbol = this.#symbolsById.get(other);
			if (relatedSymbol !== undefined) fileIds.add(relatedSymbol.fileId);
		}
		return [...fileIds].slice(0, 8).flatMap((fileId) => {
			const architectureFile = this.#filesById.get(fileId);
			return architectureFile === undefined ? [] : [fileCandidate(architectureFile, state.score, state.confidence, [...state.reasons, architectureReason(architecture)], state.edges, state.aliases, state.hop)];
		});
	}

	#definitionCandidate(seed: SeedMatch): RepoMapQueryCandidate[] {
		const file = this.#filesById.get(seed.symbol.fileId);
		if (file === undefined) return [];
		const exportEdge = (this.#incoming.get(seed.symbol.id) ?? []).find((edge) => edge.kind === "exports" || edge.kind === "exports-publicly");
		return [symbolCandidate(
			file,
			seed.symbol,
			seed.score - 40 + (exportEdge === undefined ? 0 : 35),
			exportEdge?.confidence ?? seed.confidence,
			["definition", ...(seed.reasons.includes("alias") ? ["alias" as const] : []), ...(seed.symbol.visibility === "public" ? ["public api" as const] : []), ...(exportEdge === undefined ? [] : ["export" as const])],
			exportEdge === undefined ? [] : [this.#edgeDetails(exportEdge, 1)],
			seed.aliases,
		)];
	}

	#incomingSymbolRelations(query: string, kind: "references" | "calls", reason: "reference" | "caller", score: number): RepoMapQueryCandidate[] {
		const result: RepoMapQueryCandidate[] = [];
		for (const seed of this.#seedSymbols(query)) {
			for (const edge of this.#incoming.get(seed.symbol.id) ?? []) {
				if (edge.kind !== kind) continue;
				const source = this.#symbolsById.get(edge.from);
				const file = source === undefined ? undefined : this.#filesById.get(source.fileId);
				if (source !== undefined && file !== undefined) result.push(symbolCandidate(file, source, score, edge.confidence, [reason], [this.#edgeDetails(edge, 1)], seed.aliases, 1));
			}
		}
		return coalesceCandidates(result);
	}

	#outgoingSymbolRelations(query: string, kind: "references" | "calls", reason: "reference" | "callee", score: number): RepoMapQueryCandidate[] {
		const result: RepoMapQueryCandidate[] = [];
		for (const seed of this.#seedSymbols(query)) {
			for (const edge of this.#outgoing.get(seed.symbol.id) ?? []) {
				if (edge.kind !== kind) continue;
				const target = this.#symbolsById.get(edge.to);
				const file = target === undefined ? undefined : this.#filesById.get(target.fileId);
				if (target !== undefined && file !== undefined) result.push(symbolCandidate(file, target, score, edge.confidence, [reason], [this.#edgeDetails(edge, 1)], seed.aliases, 1));
			}
		}
		return coalesceCandidates(result);
	}

	#neighbors(nodeId: string): RepoMapEdge[] {
		return uniqueEdges([...(this.#outgoing.get(nodeId) ?? []), ...(this.#incoming.get(nodeId) ?? [])]);
	}

	#degree(nodeId: string): number {
		return this.#neighbors(nodeId).length;
	}

	#isKnownNode(nodeId: string): boolean {
		return this.#filesById.has(nodeId) || this.#symbolsById.has(nodeId) || this.#architectureById.has(nodeId);
	}

	#edgeDetails(edge: RepoMapEdge, hop: 1 | 2): RepoMapRelatedEdge {
		const relatedFiles = [edge.from, edge.to]
			.map((id) => this.#filesById.get(id) ?? this.#filesById.get(this.#symbolsById.get(id)?.fileId ?? "") ?? fileForArchitecture(id, this.#architectureById, this.#filesById))
			.concat(edge.evidence.flatMap((evidence) => [...this.#filesById.values()].find((file) => file.path === evidence.path) ?? []))
			.filter((file): file is RepoMapFileRecord => file !== undefined)
			.filter((file, index, files) => files.findIndex((item) => item.id === file.id) === index)
			.map((file) => ({ path: file.path, ...(file.contentHash !== undefined ? { contentHash: file.contentHash } : {}) }));
		return { kind: edge.kind, from: edge.from, to: edge.to, confidence: edge.confidence, resolution: edge.resolution, source: edge.source, hop, evidence: edge.evidence, relatedFiles };
	}

	#packDiverse(candidates: readonly RepoMapQueryCandidate[], limit: number): RepoMapQueryCandidate[] {
		if (limit === 0) return [];
		const remaining = [...candidates];
		const selected: RepoMapQueryCandidate[] = [];
		const roles = new Set<string>();
		const components = new Set<string>();
		const paths = new Map<string, number>();
		while (remaining.length > 0 && selected.length < limit) {
			let bestIndex = 0;
			let bestUtility = Number.NEGATIVE_INFINITY;
			for (let index = 0; index < remaining.length; index += 1) {
				const candidate = remaining[index];
				if (candidate === undefined) continue;
				const role = candidateRole(candidate);
				const component = this.#componentForFile(candidate.fileId);
				const utility = candidate.score
					+ (roles.has(role) ? 0 : 55)
					+ (component === undefined || components.has(component) ? 0 : 40)
					- (paths.get(candidate.path) ?? 0) * 90
					- candidate.hop * 12;
				if (utility > bestUtility || (utility === bestUtility && compareCandidates(candidate, remaining[bestIndex] ?? candidate) < 0)) {
					bestUtility = utility;
					bestIndex = index;
				}
			}
			const [chosen] = remaining.splice(bestIndex, 1);
			if (chosen === undefined) break;
			selected.push(chosen);
			roles.add(candidateRole(chosen));
			const component = this.#componentForFile(chosen.fileId);
			if (component !== undefined) components.add(component);
			paths.set(chosen.path, (paths.get(chosen.path) ?? 0) + 1);
		}
		return selected;
	}

	#componentForFile(fileId: string): string | undefined {
		return (this.#outgoing.get(fileId) ?? []).find((edge) => edge.kind === "belongs-to" && this.#architectureById.get(edge.to)?.kind === "component")?.to;
	}
}

function fileCandidate(
	file: RepoMapFileRecord,
	score: number,
	confidence: number,
	reasons: RepoMapMatchReason[],
	relatedEdges: RepoMapRelatedEdge[] = [],
	matchedAliases: RepoMapAliasMatch[] = [],
	hop: 0 | 1 | 2 = 0,
): RepoMapQueryCandidate {
	return {
		path: file.path,
		fileId: file.id,
		...(file.contentHash !== undefined ? { contentHash: file.contentHash } : {}),
		score,
		confidence,
		hop,
		reasons: unique(reasons),
		matchedAliases,
		relatedEdges,
	};
}

function symbolCandidate(
	file: RepoMapFileRecord,
	symbol: RepoMapSymbolNode,
	score: number,
	confidence: number,
	reasons: RepoMapMatchReason[],
	relatedEdges: RepoMapRelatedEdge[],
	matchedAliases: RepoMapAliasMatch[] = [],
	hop: 0 | 1 | 2 = 0,
): RepoMapQueryCandidate {
	return {
		...fileCandidate(file, score, confidence, reasons, relatedEdges, matchedAliases, hop),
		symbol: {
			id: symbol.id,
			kind: symbol.symbolKind,
			...(symbol.name !== undefined ? { name: symbol.name } : {}),
			...(symbol.qualifiedName !== undefined ? { qualifiedName: symbol.qualifiedName } : {}),
			...(symbol.signature !== undefined ? { signature: symbol.signature } : {}),
			range: range(symbol),
		},
		range: range(symbol),
	};
}

function propagationWeight(edge: RepoMapEdge, degree: number): number {
	const hubPenalty = degree <= 6 ? 1 : Math.max(0.32, Math.sqrt(6 / degree));
	return EDGE_WEIGHT[edge.kind] * RESOLUTION_WEIGHT[edge.resolution] * edge.confidence * hubPenalty;
}

function relationReason(edge: RepoMapEdge, current: string): RepoMapMatchReason {
	if (edge.kind === "calls") return edge.from === current ? "callee" : "caller";
	if (edge.kind === "references") return "reference";
	if (edge.kind === "imports") return "import";
	if (edge.kind === "exports" || edge.kind === "re-exports") return "export";
	if (edge.kind === "exports-publicly") return "public api";
	if (edge.kind.startsWith("registers-")) return "registration";
	if (edge.kind.startsWith("declares-")) return "entrypoint";
	return "component";
}

function architectureReason(node: RepoMapArchitectureNode): RepoMapMatchReason {
	if (node.kind !== "entrypoint") return node.kind;
	return node.entrypointType === "command" || node.entrypointType === "tool" || node.entrypointType === "plugin" ? "registration" : "entrypoint";
}

function candidateRole(candidate: RepoMapQueryCandidate): string {
	for (const role of ["exact path", "exact symbol", "definition", "public api", "registration", "caller", "reference", "callee", "import", "component", "alias"] as const) {
		if (candidate.reasons.includes(role)) return role;
	}
	return candidate.reasons[0] ?? "related";
}

function aliasMatch(alias: RepoMapLexicalAlias): RepoMapAliasMatch {
	return { term: alias.term, canonical: alias.canonical, source: alias.source, confidence: alias.confidence, evidence: alias.evidence };
}

function aliasKey(alias: RepoMapLexicalAlias): string {
	return [alias.target, alias.term, alias.canonical, alias.source].join("\0");
}

function fileForArchitecture(
	id: string,
	architectureById: ReadonlyMap<string, RepoMapArchitectureNode>,
	filesById: ReadonlyMap<string, RepoMapFileRecord>,
): RepoMapFileRecord | undefined {
	const node = architectureById.get(id);
	return node?.kind === "entrypoint" && node.fileId !== undefined ? filesById.get(node.fileId) : undefined;
}

function range(value: SourceRange): SourceRange {
	return { startLine: value.startLine, endLine: value.endLine, startByte: value.startByte, endByte: value.endByte };
}

function groupEdges(edges: readonly RepoMapEdge[], key: (edge: RepoMapEdge) => string): ReadonlyMap<string, RepoMapEdge[]> {
	const result = new Map<string, RepoMapEdge[]>();
	for (const edge of edges) {
		const group = result.get(key(edge)) ?? [];
		group.push(edge);
		result.set(key(edge), group);
	}
	return result;
}

function groupAliases(aliases: readonly RepoMapLexicalAlias[], key: (alias: RepoMapLexicalAlias) => string): ReadonlyMap<string, RepoMapLexicalAlias[]> {
	const result = new Map<string, RepoMapLexicalAlias[]>();
	for (const alias of aliases) {
		const group = result.get(key(alias)) ?? [];
		group.push(alias);
		result.set(key(alias), group);
	}
	return result;
}

function coalesceCandidates(candidates: readonly RepoMapQueryCandidate[]): RepoMapQueryCandidate[] {
	const result = new Map<string, RepoMapQueryCandidate>();
	for (const candidate of candidates) {
		const key = candidate.symbol?.id ?? `${candidate.fileId}:${candidate.range?.startByte ?? "file"}`;
		const existing = result.get(key);
		if (existing === undefined) {
			result.set(key, { ...candidate, reasons: [...candidate.reasons], matchedAliases: [...candidate.matchedAliases], relatedEdges: [...candidate.relatedEdges] });
			continue;
		}
		existing.score = Math.max(existing.score, candidate.score);
		existing.confidence = Math.max(existing.confidence, candidate.confidence);
		existing.hop = Math.min(existing.hop, candidate.hop) as 0 | 1 | 2;
		for (const reason of candidate.reasons) if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
		for (const alias of candidate.matchedAliases) if (!existing.matchedAliases.some((item) => aliasMatchKey(item) === aliasMatchKey(alias))) existing.matchedAliases.push(alias);
		for (const edge of candidate.relatedEdges) {
			if (!existing.relatedEdges.some((item) => item.kind === edge.kind && item.from === edge.from && item.to === edge.to && item.hop === edge.hop)) existing.relatedEdges.push(edge);
		}
	}
	return [...result.values()].sort(compareCandidates);
}

function coalesceSeeds(seeds: readonly QuerySeed[]): QuerySeed[] {
	const result = new Map<string, QuerySeed>();
	for (const seed of seeds) {
		const existing = result.get(seed.nodeId);
		if (existing === undefined) result.set(seed.nodeId, { ...seed, reasons: [...seed.reasons], aliases: [...seed.aliases] });
		else {
			existing.score = Math.max(existing.score, seed.score);
			existing.confidence = Math.max(existing.confidence, seed.confidence);
			for (const reason of seed.reasons) if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
			for (const alias of seed.aliases) if (!existing.aliases.some((item) => aliasMatchKey(item) === aliasMatchKey(alias))) existing.aliases.push(alias);
		}
	}
	return [...result.values()].sort((left, right) => right.score - left.score || compare(left.nodeId, right.nodeId));
}

function coalesceSymbolSeeds(seeds: readonly SeedMatch[]): SeedMatch[] {
	const byId = new Map<string, SeedMatch>();
	for (const seed of seeds) {
		const existing = byId.get(seed.symbol.id);
		if (existing === undefined) byId.set(seed.symbol.id, { ...seed, reasons: [...seed.reasons], aliases: [...seed.aliases] });
		else {
			existing.score = Math.max(existing.score, seed.score);
			existing.confidence = Math.max(existing.confidence, seed.confidence);
			for (const reason of seed.reasons) if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
			for (const alias of seed.aliases) if (!existing.aliases.some((item) => aliasMatchKey(item) === aliasMatchKey(alias))) existing.aliases.push(alias);
		}
	}
	return [...byId.values()].sort((left, right) => right.score - left.score || compare(left.symbol.id, right.symbol.id));
}

function uniqueEdges(edges: readonly RepoMapEdge[]): RepoMapEdge[] {
	const result = new Map<string, RepoMapEdge>();
	for (const edge of edges) result.set([edge.kind, edge.from, edge.to, edge.resolution, edge.source].join("\0"), edge);
	return [...result.values()];
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function aliasMatchKey(alias: RepoMapAliasMatch): string {
	return [alias.term, alias.canonical, alias.source].join("\0");
}

function compareCandidates(left: RepoMapQueryCandidate, right: RepoMapQueryCandidate): number {
	return right.score - left.score || left.hop - right.hop || right.confidence - left.confidence || compare(left.path, right.path) || (left.range?.startByte ?? 0) - (right.range?.startByte ?? 0);
}

function compareEdge(left: RepoMapEdge, right: RepoMapEdge): number {
	return compare(left.kind, right.kind) || compare(left.from, right.from) || compare(left.to, right.to);
}

function normalize(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//u, "").toLocaleLowerCase();
}

function lastSegment(value: string): string {
	return value.split(/[.#]/u).at(-1) ?? value;
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

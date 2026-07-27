import { byteRangeForLines, extractByteRange, languageFromPath, tokenizeText, type IndexedCodeUnit } from "../../code-index/parser.js";
import { type CandidateRole, type CandidateSignal, type RegionEvidence, type RetrievalSource, type SemanticMainRegion, type TextFileEvidence, type VerifiedCodeRegion, type RankedRegion } from "./candidates.js";
import type { ScopeInventory } from "./inventory.js";
import type { GrepGraphCandidate, GrepSymbolCandidate } from "./ports.js";
import type { QueryPlan, RelationIntent } from "./query-plan.js";
import { rankCodeRegions, selectRankedRegions } from "./ranking.js";
import type { AutoRegionizationResult, AutoRegionizedFile } from "./regionizer.js";
import type { TextScanResult } from "./text-scanner.js";
import type { GrepNearbyResult, GrepRelatedResult } from "./types.js";

interface LocalEntry {
	readonly id: string;
	readonly path: string;
	readonly startLine: number;
	readonly quality: number;
	readonly source: RetrievalSource;
	readonly reason: string;
	readonly region: Omit<SemanticMainRegion, "evidence">;
}

interface UnitFile {
	readonly file: AutoRegionizedFile;
	readonly unit: IndexedCodeUnit;
	readonly content: string;
	readonly tokens: Map<string, number>;
}

export interface LocalAutoResult {
	readonly ranked: readonly RankedRegion[];
	readonly sourceText: ReadonlyMap<string, string>;
	readonly snippets: ReadonlyMap<string, string>;
	readonly nearby: readonly GrepNearbyResult[];
	readonly related: readonly GrepRelatedResult[];
}

export interface ExternalAutoCandidates {
	readonly symbols: readonly GrepSymbolCandidate[];
	readonly graph: readonly GrepGraphCandidate[];
}

/** 将已做 scope 准入的外部 DTO 融入当前本地候选；关系候选不能独立伪装成普通 main。 */
export function augmentLocalAutoResults(
	plan: QueryPlan,
	local: LocalAutoResult,
	regionized: AutoRegionizationResult,
	external: ExternalAutoCandidates,
	resultLimit: number,
): LocalAutoResult {
	const main = new Map<string, VerifiedCodeRegion | SemanticMainRegion>();
	for (const region of local.ranked) {
		if (region.queryMatch === "verified") main.set(region.id, region);
		else if (region.lane === "main") main.set(region.id, region);
	}
	const related = [...local.related];
	const sources = new Map(regionized.files.map((file) => [file.file.path, file.content]));
	const symbolCandidates = [...external.symbols].sort(compareSymbolCandidate);
	for (const [index, candidate] of symbolCandidates.entries()) {
		const source = candidate.origin === "reference" ? "lsp-reference" as const : "lsp-symbol" as const;
		const relation = candidate.origin === "reference";
		if (relation && plan.relationIntents.length === 0) {
			related.push({
				path: candidate.path,
				kind: candidate.kind,
				start_line: candidate.startLine,
				end_line: candidate.endLine,
				symbol: candidate.symbol,
				...(candidate.signature === undefined ? {} : { signature: candidate.signature }),
				sources: [source],
				relations: ["reference"],
				query_match: "not_guaranteed",
			});
			continue;
		}
		const existing = matchingRegion(main, candidate.path, candidate.startLine, candidate.endLine, candidate.symbol);
		const evidence: RegionEvidence = { source, rank: index + 1, confidence: 1, reason: candidate.reason };
		if (existing !== undefined) {
			main.set(existing.id, mergeRegionEvidence(existing, [evidence], relation ? ["reference"] : ["definition"], relation ? ["requested_relation"] : [candidate.reason === "lsp exact symbol" ? "direct_symbol" : "symbol_prefix"]));
			continue;
		}
		const range = externalRange(sources.get(candidate.path)?.text, candidate.startLine, candidate.endLine);
		const region = semanticMainRegion({
			id: `lsp:${candidate.path}:${candidate.startLine}:${candidate.endLine}:${candidate.symbol}`,
			path: candidate.path,
			startLine: candidate.startLine,
			endLine: candidate.endLine,
			startByte: range.startByte,
			endByte: range.endByte,
			kind: candidate.kind,
			symbol: candidate.symbol,
			...(candidate.signature === undefined ? {} : { signature: candidate.signature }),
			roles: relation ? ["reference"] : ["definition"],
			signals: relation ? ["requested_relation"] : [candidate.reason === "lsp exact symbol" ? "direct_symbol" : "symbol_prefix"],
			evidence: [evidence],
			lane: "main",
		});
		main.set(region.id, region);
	}

	const graphCandidates = [...external.graph].sort(compareGraphCandidate);
	for (const [index, candidate] of graphCandidates.entries()) {
		const content = sources.get(candidate.path);
		if (candidate.contentHash !== undefined && content?.hash.replace(/^sha256:/u, "") !== candidate.contentHash.replace(/^sha256:/u, "")) continue;
		const candidateRange = candidate.symbol?.range ?? candidate.range;
		const symbol = candidate.symbol?.qualifiedName ?? candidate.symbol?.name;
		const source = candidate.hop === 0 ? "repo-map-direct" as const : candidate.hop === 1 ? "repo-map-hop-1" as const : "repo-map-hop-2" as const;
		if (candidateRange === undefined) {
			related.push({ path: candidate.path, kind: "file", sources: [source], relations: candidate.reasons.length === 0 ? ["related"] : [...candidate.reasons], query_match: "not_guaranteed" });
			continue;
		}
		const existing = matchingRegion(main, candidate.path, candidateRange.startLine, candidateRange.endLine, symbol);
		const role = graphRole(candidate.reasons);
		const relationOnly = role !== undefined && role !== "definition";
		const reasons = candidate.reasons.length === 0 ? ["repo map"] : candidate.reasons;
		const evidence: RegionEvidence[] = reasons.map((reason) => ({ source, rank: index + 1, confidence: candidate.confidence, hop: candidate.hop, reason }));
		if (existing !== undefined) {
			main.set(existing.id, mergeRegionEvidence(existing, evidence, role === undefined ? [] : [role], relationOnly ? [] : ["direct_symbol"]));
			continue;
		}
		if (relationOnly && !relationRequested(plan, role)) {
			related.push({
				path: candidate.path,
				kind: candidate.symbol?.kind ?? "region",
				start_line: candidateRange.startLine,
				end_line: candidateRange.endLine,
				...(symbol === undefined ? {} : { symbol }),
				...(candidate.symbol?.signature === undefined ? {} : { signature: candidate.symbol.signature }),
				sources: [source],
				relations: candidate.reasons.length === 0 ? [role ?? "related"] : [...candidate.reasons],
				query_match: "not_guaranteed",
			});
			continue;
		}
		const region = semanticMainRegion({
			id: candidate.symbol?.id ?? `repo:${candidate.path}:${candidateRange.startByte}:${candidateRange.endByte}`,
			path: candidate.path,
			startLine: candidateRange.startLine,
			endLine: candidateRange.endLine,
			startByte: candidateRange.startByte,
			endByte: candidateRange.endByte,
			kind: candidate.symbol?.kind ?? "region",
			...(symbol === undefined ? {} : { symbol }),
			...(candidate.symbol?.qualifiedName === undefined ? {} : { qualifiedSymbol: candidate.symbol.qualifiedName }),
			...(candidate.symbol?.signature === undefined ? {} : { signature: candidate.symbol.signature }),
			roles: role === undefined ? ["definition"] : [role],
			signals: relationOnly ? ["requested_relation"] : ["direct_symbol"],
			evidence,
			lane: "main",
		});
		main.set(region.id, region);
	}
	const ranked = selectRankedRegions(rankCodeRegions(plan, [...main.values()]), Math.max(resultLimit, main.size));
	return {
		...local,
		ranked,
		nearby: ranked.length === 0 ? local.nearby : [],
		related: dedupeRelated(related),
	};
}

function compareSymbolCandidate(left: GrepSymbolCandidate, right: GrepSymbolCandidate): number {
	return symbolCandidateOrder(left) - symbolCandidateOrder(right)
		|| compareString(left.path, right.path)
		|| left.startLine - right.startLine
		|| left.endLine - right.endLine
		|| compareString(left.symbol, right.symbol);
}

function symbolCandidateOrder(candidate: GrepSymbolCandidate): number {
	if (candidate.origin === "reference") return 2;
	return candidate.reason === "lsp exact symbol" ? 0 : 1;
}

function compareGraphCandidate(left: GrepGraphCandidate, right: GrepGraphCandidate): number {
	const leftRange = left.symbol?.range ?? left.range;
	const rightRange = right.symbol?.range ?? right.range;
	return left.hop - right.hop
		|| right.confidence - left.confidence
		|| compareString(left.path, right.path)
		|| (leftRange?.startLine ?? 0) - (rightRange?.startLine ?? 0)
		|| (leftRange?.endLine ?? 0) - (rightRange?.endLine ?? 0);
}

function matchingRegion(
	regions: ReadonlyMap<string, VerifiedCodeRegion | SemanticMainRegion>,
	path: string,
	startLine: number,
	endLine: number,
	symbol: string | undefined,
): VerifiedCodeRegion | SemanticMainRegion | undefined {
	const candidates = [...regions.values()].filter((region) => region.path === path && region.startLine <= endLine && startLine <= region.endLine);
	return candidates.find((region) => symbol !== undefined && region.symbol?.toLocaleLowerCase() === symbol.toLocaleLowerCase())
		?? candidates.sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine) || compareString(left.id, right.id))[0];
}

function mergeRegionEvidence(
	region: VerifiedCodeRegion | SemanticMainRegion,
	evidence: readonly RegionEvidence[],
	roles: readonly CandidateRole[],
	signals: readonly CandidateSignal[],
): VerifiedCodeRegion | SemanticMainRegion {
	return {
		...region,
		roles: unique([...region.roles, ...roles]),
		signals: unique([...region.signals, ...signals]),
		evidence: mergeEvidence(region.evidence, evidence),
	};
}

function externalRange(text: string | undefined, startLine: number, endLine: number): { readonly startByte: number; readonly endByte: number } {
	if (text === undefined) return { startByte: 0, endByte: 0 };
	const range = byteRangeForLines(text, startLine, endLine);
	return { startByte: range.startByte, endByte: range.endByte };
}

function graphRole(reasons: readonly string[]): CandidateRole | undefined {
	for (const role of ["caller", "callee", "reference", "test", "import", "registration"] as const) {
		if (reasons.includes(role)) return role;
	}
	if (reasons.some((reason) => reason === "definition" || reason === "declaration" || reason === "public api" || reason === "export")) return "definition";
	return undefined;
}

function relationRequested(plan: QueryPlan, role: CandidateRole | undefined): boolean {
	return role !== undefined && plan.relationIntents.some((intent) => intent === role);
}

/** scanner 证据只决定增强成本；任何直接 TextHit 均不经过此优先级过滤。 */
export function semanticParsePriority(
	inventory: ScopeInventory,
	scan: TextScanResult,
	plan: QueryPlan,
): string[] {
	const evidenceByPath = new Map(scan.fileEvidence.map((item) => [item.path, item]));
	const hitCount = new Map<string, number>();
	for (const hit of scan.hits) hitCount.set(hit.path, (hitCount.get(hit.path) ?? 0) + 1);
	return inventory.files
		.filter((file) => evidenceByPath.has(file.path) && languageFromPath(file.path) !== "text")
		.map((file) => {
			const evidence = evidenceByPath.get(file.path);
			const covered = evidence?.matchedTerms.length ?? 0;
			const phrase = evidence?.phraseLines.length ?? 0;
			const identifier = evidence?.identifierLines.length ?? 0;
			const pathTerms = evidence?.pathTerms.length ?? 0;
			const exact = hitCount.get(file.path) ?? 0;
			const shapeBoost = plan.shape === "identifier" || plan.shape === "qualified_symbol" ? identifier * 20 : phrase * 20;
			return {
				path: file.path,
				score: exact * 1_000_000 + phrase * 100_000 + shapeBoost + covered * 10_000 + pathTerms * 1_000,
				size: file.size,
			};
		})
		.sort((left, right) => right.score - left.score || left.size - right.size || compareString(left.path, right.path))
		.map((item) => item.path);
}

/** 从当前正文、派生 AST 和 scanner 证据构建不依赖外部来源的 auto 候选。 */
export function buildLocalAutoResults(
	plan: QueryPlan,
	scan: TextScanResult,
	regionized: AutoRegionizationResult,
	resultLimit: number,
): LocalAutoResult {
	const byId = new Map<string, VerifiedCodeRegion | SemanticMainRegion>();
	for (const region of regionized.regions) byId.set(region.id, enrichVerifiedRegion(region, plan));
	const entries: LocalEntry[] = [];
	const snippets = new Map<string, string>();
	const unitFiles = collectUnitFiles(regionized.files);
	const queryTerms = uniqueTerms(plan.targetTerms.length > 0 ? plan.targetTerms : [plan.query]);
	const target = (plan.targetQuery.length > 0 ? plan.targetQuery : plan.query).toLocaleLowerCase();
	const targetLast = lastSegment(target);

	for (const item of unitFiles) {
		const symbolEntry = symbolCandidate(item, plan, target, targetLast);
		if (symbolEntry !== undefined) entries.push(symbolEntry);
		const lexicalEntry = lexicalCandidate(item, plan, queryTerms);
		if (lexicalEntry !== undefined) entries.push(lexicalEntry);
	}
	entries.push(...lexicalAnchorCandidates(scan.fileEvidence, scan.hits, regionized.files, plan, queryTerms, snippets));

	const relation = relationCandidates(unitFiles, regionized.files, plan, targetLast);
	entries.push(...relation.main);
	const sourceRanks = new Map<RetrievalSource, number>();
	for (const entry of sourceRankedEntries(entries)) {
		const rank = (sourceRanks.get(entry.source) ?? 0) + 1;
		sourceRanks.set(entry.source, rank);
		addRegion(byId, withEvidence(entry, rank));
	}
	const ranked = selectRankedRegions(rankCodeRegions(plan, [...byId.values()]), Math.max(resultLimit, byId.size));
	const nearby = ranked.length === 0 ? nearbyResults(plan, unitFiles) : [];
	return {
		ranked,
		sourceText: new Map(regionized.files.map((file) => [file.file.path, file.content.text])),
		snippets,
		nearby,
		related: ranked.length < 4 ? relation.related : [],
	};
}

function collectUnitFiles(files: readonly AutoRegionizedFile[]): UnitFile[] {
	const result: UnitFile[] = [];
	for (const file of files) {
		for (const unit of file.analysis.index.units) {
			const content = extractByteRange(file.content.text, unit.startByte, unit.endByte);
			result.push({ file, unit, content, tokens: tokenizeText(content) });
		}
	}
	return result;
}

function enrichVerifiedRegion(region: VerifiedCodeRegion, plan: QueryPlan): VerifiedCodeRegion {
	const exactSignal: CandidateSignal = plan.shape === "qualified_symbol"
		? "verified_qualified_occurrence"
		: plan.shape === "identifier"
			? "verified_text"
			: "verified_phrase";
	return {
		...region,
		signals: unique([...region.signals, exactSignal]),
	};
}

function symbolCandidate(item: UnitFile, plan: QueryPlan, target: string, targetLast: string): LocalEntry | undefined {
	const symbol = item.unit.name?.toLocaleLowerCase();
	const qualified = item.unit.qualifiedName?.toLocaleLowerCase();
	let signal: CandidateSignal | undefined;
	let reason: string | undefined;
	let quality = 0;
	if (qualified !== undefined && qualified === target) {
		signal = "exact_qualified_definition";
		reason = "exact qualified symbol";
		quality = 100;
	} else if (symbol !== undefined && symbol === target) {
		signal = "exact_symbol_definition";
		reason = "exact symbol";
		quality = 90;
	} else if (plan.shape === "qualified_symbol" && symbol !== undefined && symbol === targetLast) {
		signal = "exact_member_definition";
		reason = "exact member";
		quality = 80;
	} else {
		const candidate = qualified ?? symbol;
		if (candidate !== undefined && target.length >= 2 && candidate.startsWith(target)) {
			signal = "symbol_prefix";
			reason = "symbol prefix";
			quality = 50 - Math.min(20, candidate.length - target.length);
		}
	}
	if (signal === undefined || reason === undefined) return undefined;
	const signals = plan.relationIntents.length > 0 && (symbol === targetLast || qualified === target)
		? [signal, "target_definition" as const]
		: [signal];
	return localEntry(item, "ast-symbol", reason, quality, ["definition"], signals);
}

function lexicalCandidate(item: UnitFile, plan: QueryPlan, queryTerms: readonly string[]): LocalEntry | undefined {
	const matched = queryTerms.filter((term) => item.tokens.has(term));
	if (!passesCoverage(plan, matched.length, queryTerms.length)) return undefined;
	const coverage = matched.length / Math.max(1, queryTerms.length);
	const highCoverage = queryTerms.length > 1 && coverage >= 0.6;
	return localEntry(
		item,
		"ast-lexical",
		"lexical",
		matched.length * 100 + Math.round(coverage * 50) - Math.min(40, item.unit.endLine - item.unit.startLine),
		["definition"],
		[highCoverage ? "lexical_high_coverage" : "lexical"],
	);
}

function localEntry(
	item: UnitFile,
	source: RetrievalSource,
	reason: string,
	quality: number,
	roles: readonly CandidateRole[],
	signals: readonly CandidateSignal[],
): LocalEntry {
	return {
		id: item.unit.id,
		path: item.unit.path,
		startLine: item.unit.startLine,
		quality,
		source,
		reason,
		region: semanticMainRegion({
			id: item.unit.id,
			path: item.unit.path,
			startLine: item.unit.startLine,
			endLine: item.unit.endLine,
			startByte: item.unit.startByte,
			endByte: item.unit.endByte,
			kind: item.unit.kind,
			...(item.unit.name === undefined ? {} : { symbol: item.unit.qualifiedName ?? item.unit.name }),
			...(item.unit.qualifiedName === undefined ? {} : { qualifiedSymbol: item.unit.qualifiedName }),
			...(item.unit.signature === undefined ? {} : { signature: item.unit.signature }),
			roles,
			signals,
			evidence: [],
			lane: "main",
		}),
	};
}

function lexicalAnchorCandidates(
	evidence: readonly TextFileEvidence[],
	hits: readonly { readonly path: string; readonly line: number }[],
	parsedFiles: readonly AutoRegionizedFile[],
	plan: QueryPlan,
	queryTerms: readonly string[],
	snippets: Map<string, string>,
): LocalEntry[] {
	const unitsByPath = new Map(parsedFiles.map((file) => [file.file.path, file.analysis.index.units]));
	const exactLines = new Set(hits.map((hit) => `${hit.path}\0${hit.line}`));
	const result: LocalEntry[] = [];
	for (const file of evidence) {
		for (const anchor of file.anchors) {
			if (exactLines.has(`${anchor.path}\0${anchor.line}`)) continue;
			if (!passesCoverage(plan, anchor.matchedTerms.length, queryTerms.length) && !anchor.phrase && !anchor.identifier) continue;
			const enclosing = unitsByPath.get(file.path)
				?.filter((unit) => unit.startLine <= anchor.line && anchor.line <= unit.endLine)
				.sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine))[0];
			if (enclosing !== undefined) continue;
			const highCoverage = anchor.phrase || (queryTerms.length > 1 && anchor.matchedTerms.length / queryTerms.length >= 0.6);
			const id = `${anchor.path}:${anchor.line}:${anchor.byteStart}:${anchor.byteEnd}:lexical`;
			snippets.set(id, [...anchor.before, anchor.lineText, ...anchor.after].join("\n"));
			result.push({
				id,
				path: anchor.path,
				startLine: Math.max(1, anchor.line - anchor.before.length),
				quality: anchor.matchedTerms.length * 100 + (anchor.phrase ? 100 : 0) + (anchor.commentLike || anchor.stringLike ? 5 : 0),
				source: "text-lexical",
				reason: "lexical",
				region: semanticMainRegion({
					id,
					path: anchor.path,
					startLine: Math.max(1, anchor.line - anchor.before.length),
					endLine: anchor.line + anchor.after.length,
					startByte: anchor.byteStart,
					endByte: anchor.byteEnd,
					kind: "text",
					roles: ["text"],
					signals: [highCoverage ? "lexical_high_coverage" : "lexical"],
					evidence: [],
					lane: "main",
				}),
			});
		}
	}
	return result;
}

function relationCandidates(
	units: readonly UnitFile[],
	files: readonly AutoRegionizedFile[],
	plan: QueryPlan,
	target: string,
): { readonly main: LocalEntry[]; readonly related: GrepRelatedResult[] } {
	if (target.length === 0) return { main: [], related: [] };
	const definitions = new Map<string, UnitFile[]>();
	for (const item of units) {
		for (const definition of item.unit.definitions) {
			const key = definition.toLocaleLowerCase();
			const grouped = definitions.get(key);
			if (grouped === undefined) definitions.set(key, [item]);
			else grouped.push(item);
		}
	}
	const requested = new Set(plan.relationIntents);
	const main: LocalEntry[] = [];
	const related: GrepRelatedResult[] = [];
	const add = (item: UnitFile, role: Extract<CandidateRole, "caller" | "callee" | "reference" | "test" | "registration">, intent: RelationIntent): void => {
		if (requested.has(intent)) {
			main.push(localEntry(item, "ast-relation", intent, 100, [role], ["requested_relation"]));
		} else if (plan.relationIntents.length === 0) {
			related.push(toRelated(item.unit, intent));
		}
	};
	for (const item of units) {
		if (item.unit.calls.some((call) => lastSegment(call.toLocaleLowerCase()) === target)) add(item, "caller", "caller");
		if (item.unit.references.some((reference) => lastSegment(reference.toLocaleLowerCase()) === target)) add(item, "reference", "reference");
		if (isTestPath(item.unit.path) && unitMentionsTarget(item, target)) add(item, "test", "test");
		if (item.unit.calls.some((call) => /register/iu.test(call)) && unitMentionsTarget(item, target)) add(item, "registration", "registration");
	}
	for (const definition of definitions.get(target) ?? []) {
		for (const call of definition.unit.calls) {
			for (const callee of definitions.get(lastSegment(call.toLocaleLowerCase())) ?? []) add(callee, "callee", "callee");
		}
	}
	for (const file of files) {
		for (const imported of file.analysis.imports) {
			if (!imported.specifier.toLocaleLowerCase().includes(target)) continue;
			if (requested.has("import")) {
				const id = `${file.file.path}:${imported.startByte}:${imported.endByte}:import`;
				main.push({
					id,
					path: file.file.path,
					startLine: imported.startLine,
					quality: 100,
					source: "ast-relation",
					reason: "import",
					region: semanticMainRegion({
						id,
						path: file.file.path,
						startLine: imported.startLine,
						endLine: imported.endLine,
						startByte: imported.startByte,
						endByte: imported.endByte,
						kind: "import",
						roles: ["import"],
						signals: ["requested_relation"],
						evidence: [],
						lane: "main",
					}),
				});
			} else if (plan.relationIntents.length === 0) {
				related.push({
					path: file.file.path,
					kind: "import",
					start_line: imported.startLine,
					end_line: imported.endLine,
					sources: ["ast-relation"],
					relations: ["import"],
					query_match: "not_guaranteed",
				});
			}
		}
	}
	return { main, related: dedupeRelated(related) };
}

function semanticMainRegion(input: Omit<SemanticMainRegion, "queryMatch" | "matchLines">): SemanticMainRegion {
	return { ...input, queryMatch: "semantic", matchLines: [] };
}

function sourceRankedEntries(entries: readonly LocalEntry[]): LocalEntry[] {
	const bySource = new Map<RetrievalSource, LocalEntry[]>();
	for (const entry of entries) {
		const grouped = bySource.get(entry.source);
		if (grouped === undefined) bySource.set(entry.source, [entry]);
		else grouped.push(entry);
	}
	const ranked: LocalEntry[] = [];
	for (const source of [...bySource.keys()].sort(compareString)) {
		const sourceEntries = bySource.get(source) ?? [];
		sourceEntries.sort((left, right) => right.quality - left.quality || compareString(left.path, right.path) || left.startLine - right.startLine || compareString(left.id, right.id));
		ranked.push(...sourceEntries);
	}
	return ranked;
}

function withEvidence(entry: LocalEntry, rank: number): SemanticMainRegion {
	return { ...entry.region, evidence: [{ source: entry.source, rank, confidence: 1, reason: entry.reason }] };
}

function addRegion(
	regions: Map<string, VerifiedCodeRegion | SemanticMainRegion>,
	incoming: SemanticMainRegion,
): void {
	const existing = regions.get(incoming.id);
	if (existing === undefined) {
		regions.set(incoming.id, incoming);
		return;
	}
	const roles = unique([...existing.roles, ...incoming.roles]);
	const signals = unique([...existing.signals, ...incoming.signals]);
	const evidence = mergeEvidence(existing.evidence, incoming.evidence);
	if (existing.queryMatch === "verified") regions.set(existing.id, { ...existing, roles, signals, evidence });
	else regions.set(existing.id, { ...existing, roles, signals, evidence });
}

function mergeEvidence(left: readonly RegionEvidence[], right: readonly RegionEvidence[]): RegionEvidence[] {
	const result = new Map<string, RegionEvidence>();
	for (const item of [...left, ...right]) {
		const key = `${item.source}\0${item.reason}`;
		const current = result.get(key);
		if (current === undefined || item.rank < current.rank) result.set(key, item);
	}
	return [...result.values()];
}

function passesCoverage(plan: QueryPlan, matched: number, total: number): boolean {
	if (total === 0) return false;
	if (total === 1) return matched === 1;
	const required = plan.shape === "natural_language" || plan.shape === "long_text"
		? Math.max(2, Math.ceil(total * 0.6))
		: Math.min(2, total);
	return matched >= required;
}

function nearbyResults(plan: QueryPlan, units: readonly UnitFile[]): GrepNearbyResult[] {
	const query = (plan.targetQuery.length > 0 ? plan.targetQuery : plan.query).toLocaleLowerCase();
	const queryTokens = tokenizeText(query);
	return units
		.map((item) => {
			const symbol = item.unit.qualifiedName ?? item.unit.name;
			const distance = symbol === undefined ? undefined : nearestSymbolDistance(query, symbol.toLocaleLowerCase());
			const overlap = tokenOverlap(queryTokens, item.tokens);
			const pathOverlap = tokenOverlap(queryTokens, tokenizeText(item.unit.path));
			const reason: GrepNearbyResult["reason"] | undefined = distance !== undefined
				? "symbol similarity"
				: overlap > 0
					? "partial terms"
					: pathOverlap > 0 ? "path similarity" : undefined;
			return { item, symbol, distance, overlap, pathOverlap, reason };
		})
		.filter((item): item is typeof item & { reason: GrepNearbyResult["reason"] } => item.reason !== undefined)
		.sort((left, right) => nearbyReasonOrder(left.reason) - nearbyReasonOrder(right.reason)
			|| (left.distance ?? Number.POSITIVE_INFINITY) - (right.distance ?? Number.POSITIVE_INFINITY)
			|| right.overlap - left.overlap
			|| right.pathOverlap - left.pathOverlap
			|| compareString(left.item.unit.path, right.item.unit.path)
			|| left.item.unit.startLine - right.item.unit.startLine)
		.slice(0, 3)
		.map(({ item, symbol, reason }) => ({
			path: item.unit.path,
			start_line: item.unit.startLine,
			end_line: item.unit.endLine,
			kind: item.unit.kind,
			...(symbol === undefined ? {} : { symbol }),
			...(item.unit.signature === undefined ? {} : { signature: item.unit.signature }),
			reason,
			query_match: "not_guaranteed",
		}));
}

function toRelated(unit: IndexedCodeUnit, relation: string): GrepRelatedResult {
	return {
		path: unit.path,
		kind: unit.kind,
		start_line: unit.startLine,
		end_line: unit.endLine,
		...(unit.qualifiedName ?? unit.name ? { symbol: unit.qualifiedName ?? unit.name } : {}),
		...(unit.signature === undefined ? {} : { signature: unit.signature }),
		sources: ["ast-relation"],
		relations: [relation],
		query_match: "not_guaranteed",
	};
}

function dedupeRelated(values: readonly GrepRelatedResult[]): GrepRelatedResult[] {
	const result = new Map<string, GrepRelatedResult>();
	for (const value of values) {
		const key = `${value.path}\0${value.start_line ?? 0}\0${value.end_line ?? 0}\0${value.relations.join(",")}`;
		if (!result.has(key)) result.set(key, value);
	}
	return [...result.values()].sort((left, right) => compareString(left.path, right.path) || (left.start_line ?? 0) - (right.start_line ?? 0)).slice(0, 12);
}

function unitMentionsTarget(item: UnitFile, target: string): boolean {
	return item.tokens.has(target)
		|| item.unit.calls.some((call) => lastSegment(call.toLocaleLowerCase()) === target)
		|| item.unit.references.some((reference) => lastSegment(reference.toLocaleLowerCase()) === target);
}

function isTestPath(path: string): boolean {
	return /(?:^|\/)(?:test|tests|spec|specs)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$/iu.test(path);
}

function uniqueTerms(values: readonly string[]): string[] {
	return [...new Set(values.flatMap((value) => [...tokenizeText(value).keys()]))];
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function lastSegment(value: string): string {
	return value.split(/[.:#]/u).at(-1) ?? value;
}

function nearestSymbolDistance(query: string, symbol: string): number | undefined {
	if (query.length === 0 || query.includes(" ")) return undefined;
	const candidates = [symbol, lastSegment(symbol)];
	let nearest: number | undefined;
	for (const candidate of candidates) {
		const length = Math.max(1, Math.min(query.length, candidate.length));
		const maximum = length <= 4 ? 1 : length <= 10 ? 2 : 3;
		if (Math.abs(query.length - candidate.length) > maximum) continue;
		const distance = editDistance(query, candidate);
		if (distance <= maximum && distance / length <= 0.3 && (nearest === undefined || distance < nearest)) nearest = distance;
	}
	return nearest;
}

function editDistance(left: string, right: string): number {
	let previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		const current = [leftIndex];
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			current[rightIndex] = Math.min(
				(current[rightIndex - 1] ?? 0) + 1,
				(previous[rightIndex] ?? 0) + 1,
				(previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
			);
		}
		previous = current;
	}
	return previous[right.length] ?? Math.max(left.length, right.length);
}

function tokenOverlap(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): number {
	let result = 0;
	for (const token of left.keys()) if (right.has(token)) result += 1;
	return result;
}

function nearbyReasonOrder(reason: GrepNearbyResult["reason"]): number {
	if (reason === "symbol similarity") return 0;
	if (reason === "partial terms") return 1;
	return 2;
}

function compareString(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

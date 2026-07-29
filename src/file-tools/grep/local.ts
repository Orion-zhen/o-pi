import { languageFromPath, tokenizeText, type IndexedCodeUnit } from "../../code-index/parser.js";
import { extractByteRange } from "../../filesystem/services/text.js";
import { compactDisplayLine, firstTermFocus } from "./display.js";
import { createSemanticCodeRegion, normalizeMatchedBy, type CandidateRole, type CandidateSignal, type CodeRegion, type LexicalTextAnchor, type RegionEvidence, type RetrievalSource, type SemanticMainRegion, type TextFileEvidence, type VerifiedCodeRegion, type RankedRegion } from "./candidates.js";
import type { GrepDisplayLine } from "./types.js";
import type { ScopeInventory } from "./inventory.js";
import type { QueryPlan, RelationIntent } from "./query-plan.js";
import { scoreLexicalRegions, type LexicalRegionScore } from "./lexical-scorer.js";
import { assignSourceLocalRanks, classifySymbolMatch, rankCodeRegions, selectRankedRegions } from "./ranking.js";
import type { AutoRegionizationResult, AutoRegionizedFile } from "./regionizer.js";
import type { TextScanResult } from "./text-scanner.js";
import type { GrepNearbyResult } from "./types.js";

interface LocalEntry {
	readonly id: string;
	readonly path: string;
	readonly startLine: number;
	readonly quality: number;
	readonly source: RetrievalSource;
	readonly reason: string;
	readonly region: SemanticMainRegion;
}

interface UnitFile {
	readonly file: AutoRegionizedFile;
	readonly unit: IndexedCodeUnit;
	readonly content: string;
	readonly tokens: Map<string, number>;
}

export interface LocalAutoResult {
	readonly regions: readonly CodeRegion[];
	readonly ranked: readonly RankedRegion[];
	readonly totalCandidates: number;
	readonly nearby: readonly GrepNearbyResult[];
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
				size: file.snapshot.sizeBytes,
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
	displayLimit: number,
): LocalAutoResult {
	const byId = new Map<string, VerifiedCodeRegion | SemanticMainRegion>();
	for (const region of regionized.regions) byId.set(region.id, enrichVerifiedRegion(region, plan));
	const entries: LocalEntry[] = [];
	const unitFiles = collectUnitFiles(regionized.files);
	const queryTerms = uniqueTerms(plan.targetTerms.length > 0 ? plan.targetTerms : [plan.query]);
	const target = (plan.targetQuery.length > 0 ? plan.targetQuery : plan.query).toLocaleLowerCase();
	const targetLast = lastSegment(target);
	const groupedAnchors = groupLexicalAnchors(scan.fileEvidence, unitFiles);
	const lexicalScores = scoreLexicalRegions(unitFiles.map((item) => ({
		unit: item.unit,
		content: item.content,
		anchors: groupedAnchors.byUnit.get(item.unit.id) ?? [],
	})), plan, queryTerms);

	for (const item of unitFiles) {
		const symbolEntry = symbolCandidate(item, plan, targetLast);
		if (symbolEntry !== undefined) entries.push(symbolEntry);
		const lexicalEntry = lexicalCandidate(item, plan, queryTerms, lexicalScores.get(item.unit.id), displayLimit);
		if (lexicalEntry !== undefined) entries.push(lexicalEntry);
	}
	entries.push(...lexicalAnchorCandidates(groupedAnchors.outside, scan.hits, plan, queryTerms));

	entries.push(...relationCandidates(unitFiles, regionized.files, plan, targetLast));
	const sourceRanks = assignSourceLocalRanks(entries, (entry) => entry.source, compareLocalEntries);
	for (const entry of entries) addRegion(byId, withEvidence(entry, sourceRanks.get(entry) ?? Number.MAX_SAFE_INTEGER));
	const regions = [...byId.values()];
	const allRanked = rankCodeRegions(plan, regions);
	const ranked = selectRankedRegions(allRanked, allRanked.length);
	const nearby = allRanked.length === 0 ? nearbyResults(plan, unitFiles) : [];
	return {
		regions,
		ranked,
		totalCandidates: allRanked.length,
		nearby,
	};
}

function collectUnitFiles(files: readonly AutoRegionizedFile[]): UnitFile[] {
	const result: UnitFile[] = [];
	for (const file of files) {
		for (const unit of file.analysis.index.units) {
			const extracted = extractByteRange(file.content.text, unit.startByte, unit.endByte);
			if (extracted === undefined) continue;
			const content = extracted.replace(/\s+$/u, "");
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

function symbolCandidate(item: UnitFile, plan: QueryPlan, targetLast: string): LocalEntry | undefined {
	const signal = classifySymbolMatch(plan, item.unit.name, item.unit.qualifiedName);
	if (signal === undefined) return undefined;
	const leaf = item.unit.name?.toLocaleLowerCase() ?? "";
	const quality = signal === "exact_qualified_definition" ? 100
		: signal === "exact_symbol_definition" ? 90
			: signal === "exact_member_definition" ? 80
				: 50 - Math.min(20, Math.max(0, leaf.length - targetLast.length));
	const reason = signal === "exact_qualified_definition" ? "exact qualified symbol"
		: signal === "exact_symbol_definition" ? "exact symbol"
			: signal === "exact_member_definition" ? "exact member"
				: "symbol prefix";
	const signals = plan.relationIntents.length > 0 && signal !== "symbol_prefix"
		? [signal, "target_definition" as const]
		: [signal];
	return localEntry(item, "ast-symbol", reason, quality, unitRoles(item), signals);
}

function lexicalCandidate(
	item: UnitFile,
	plan: QueryPlan,
	queryTerms: readonly string[],
	score: LexicalRegionScore | undefined,
	displayLimit: number,
): LocalEntry | undefined {
	if (score === undefined || !passesCoverage(plan, score.matchedTerms.length, queryTerms.length)) return undefined;
	const declarationTerms = item.unit.signature === undefined
		? new Set<string>()
		: new Set([...tokenizeText(item.unit.signature).keys()]);
	const displayLines = score.evidenceLines
		.filter((line) => !line.matchedTerms.every((term) => declarationTerms.has(term)))
		.slice(0, displayLimit)
		.map((line): GrepDisplayLine => {
			const focus = firstTermFocus(line.text, line.matchedTerms);
			return { line: line.line, text: compactDisplayLine(line.text, focus.start, focus.end), type: "evidence" };
		});
	return localEntry(
		item,
		"ast-lexical",
		"lexical",
		score.quality,
		unitRoles(item),
		[score.highCoverage ? "lexical_high_coverage" : "lexical"],
		displayLines,
	);
}

function localEntry(
	item: UnitFile,
	source: RetrievalSource,
	reason: string,
	quality: number,
	roles: readonly CandidateRole[],
	signals: readonly CandidateSignal[],
	displayLines: readonly GrepDisplayLine[] = [],
): LocalEntry {
	return {
		id: item.unit.id,
		path: item.unit.path,
		startLine: item.unit.startLine,
		quality,
		source,
		reason,
		region: createSemanticCodeRegion({
			id: item.unit.id,
			path: item.unit.path,
			startLine: item.unit.startLine,
			endLine: item.unit.endLine,
			startByte: item.unit.startByte,
			endByte: item.unit.endByte,
			kind: item.unit.kind,
			...(item.unit.name === undefined ? {} : { symbol: item.unit.qualifiedName ?? item.unit.name }),
			...(item.unit.qualifiedName === undefined ? {} : { qualifiedSymbol: item.unit.qualifiedName }),
			...(item.unit.signature === undefined ? {} : { declaration: item.unit.signature }),
			...(item.unit.declarationEndByte === undefined ? {} : { declarationEndByte: item.unit.declarationEndByte }),
			roles,
			signals,
			evidence: [],
			displayLines,
			lane: "main",
		}),
	};
}

function groupLexicalAnchors(
	evidence: readonly TextFileEvidence[],
	units: readonly UnitFile[],
): { readonly byUnit: ReadonlyMap<string, readonly LexicalTextAnchor[]>; readonly outside: readonly LexicalTextAnchor[] } {
	const unitsByPath = new Map<string, UnitFile[]>();
	for (const item of units) {
		const grouped = unitsByPath.get(item.unit.path);
		if (grouped === undefined) unitsByPath.set(item.unit.path, [item]);
		else grouped.push(item);
	}
	const byUnit = new Map<string, LexicalTextAnchor[]>();
	const outside: LexicalTextAnchor[] = [];
	for (const file of evidence) {
		for (const anchor of file.anchors) {
			const enclosing = unitsByPath.get(file.path)
				?.filter((item) => item.unit.startLine <= anchor.line && anchor.line <= item.unit.endLine)
				.sort((left, right) => (left.unit.endLine - left.unit.startLine) - (right.unit.endLine - right.unit.startLine)
					|| left.unit.startLine - right.unit.startLine || compareString(left.unit.id, right.unit.id))[0];
			if (enclosing === undefined) {
				outside.push(anchor);
				continue;
			}
			const grouped = byUnit.get(enclosing.unit.id);
			if (grouped === undefined) byUnit.set(enclosing.unit.id, [anchor]);
			else grouped.push(anchor);
		}
	}
	return { byUnit, outside };
}

function lexicalAnchorCandidates(
	anchors: readonly LexicalTextAnchor[],
	hits: readonly { readonly path: string; readonly line: number }[],
	plan: QueryPlan,
	queryTerms: readonly string[],
): LocalEntry[] {
	const exactLines = new Set(hits.map((hit) => `${hit.path}\0${hit.line}`));
	const result: LocalEntry[] = [];
	for (const anchor of anchors) {
		if (exactLines.has(`${anchor.path}\0${anchor.line}`)) continue;
		if (!passesCoverage(plan, anchor.matchedTerms.length, queryTerms.length) && !anchor.phrase && !anchor.identifier) continue;
		const highCoverage = anchor.phrase || (queryTerms.length > 1 && anchor.matchedTerms.length / queryTerms.length >= 0.6);
		const id = `${anchor.path}:${anchor.line}:${anchor.byteStart}:${anchor.byteEnd}:lexical`;
		const focus = firstTermFocus(anchor.lineText, anchor.matchedTerms);
		result.push({
			id,
			path: anchor.path,
			startLine: anchor.line,
			quality: anchor.matchedTerms.length * 100 + (anchor.phrase ? 100 : 0) + (anchor.commentLike || anchor.stringLike ? 5 : 0),
			source: "text-lexical",
			reason: "lexical",
			region: createSemanticCodeRegion({
				id,
				path: anchor.path,
				startLine: anchor.line,
				endLine: anchor.line,
				startByte: anchor.byteStart,
				endByte: anchor.byteEnd,
				kind: "text",
				roles: ["text"],
				signals: [highCoverage ? "lexical_high_coverage" : "lexical"],
				evidence: [],
				displayLines: [{ line: anchor.line, text: compactDisplayLine(anchor.lineText, focus.start, focus.end), type: "evidence" }],
				lane: "main",
			}),
		});
	}
	return result;
}

function relationCandidates(
	units: readonly UnitFile[],
	files: readonly AutoRegionizedFile[],
	plan: QueryPlan,
	target: string,
): LocalEntry[] {
	if (target.length === 0 || plan.relationIntents.length === 0) return [];
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
	const add = (item: UnitFile, role: Extract<CandidateRole, "caller" | "callee" | "reference" | "test" | "registration">, intent: RelationIntent): void => {
		if (requested.has(intent)) main.push(localEntry(item, "ast-relation", intent, 100, [role], ["requested_relation"]));
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
					region: createSemanticCodeRegion({
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
			}
		}
	}
	return main;
}

function compareLocalEntries(left: LocalEntry, right: LocalEntry): number {
	return right.quality - left.quality
		|| compareString(left.path, right.path)
		|| left.startLine - right.startLine
		|| compareString(left.id, right.id);
}

function withEvidence(entry: LocalEntry, rank: number): SemanticMainRegion {
	const evidence = [{ source: entry.source, rank, confidence: 1, reason: entry.reason }] as const;
	return { ...entry.region, evidence, matchedBy: normalizeMatchedBy(entry.region.signals, evidence) };
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
	const matchedBy = normalizeMatchedBy(signals, evidence);
	if (existing.queryMatch === "verified") regions.set(existing.id, { ...existing, roles, signals, evidence, matchedBy });
	else regions.set(existing.id, { ...existing, roles, signals, evidence, matchedBy });
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
			reason,
			query_match: "not_guaranteed",
		}));
}

function unitMentionsTarget(item: UnitFile, target: string): boolean {
	return item.tokens.has(target)
		|| item.unit.calls.some((call) => lastSegment(call.toLocaleLowerCase()) === target)
		|| item.unit.references.some((reference) => lastSegment(reference.toLocaleLowerCase()) === target);
}

function unitRoles(item: UnitFile): CandidateRole[] {
	const roles: CandidateRole[] = ["definition"];
	if (item.unit.exported) roles.push("public_api");
	if (isTestPath(item.unit.path)) roles.push("test");
	if (isConfigPath(item.unit.path)) roles.push("config");
	return roles;
}

function isTestPath(path: string): boolean {
	return /(?:^|\/)(?:test|tests|spec|specs)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$/iu.test(path);
}

function isConfigPath(path: string): boolean {
	return /(?:^|\/)(?:config|configs)(?:\/|$)|(?:^|\/)[^/]*config[^/]*\.[^/]+$/iu.test(path);
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

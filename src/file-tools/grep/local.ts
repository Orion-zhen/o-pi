import { languageFromPath, tokenizeText, type IndexedCodeUnit } from "../../code-index/parser.js";
import { compactDisplayLine, firstTermFocus } from "./display.js";
import {
	createSemanticCodeRegion,
	normalizeMatchedBy,
	type CandidateRole,
	type CandidateSignal,
	type CodeRegion,
	type LexicalTextAnchor,
	type RankedRegion,
	type RegionEvidence,
	type RetrievalSource,
	type SemanticMainRegion,
	type VerifiedCodeRegion,
} from "./candidates.js";
import type { ScopeInventory } from "./inventory.js";
import type { QueryPlan, RelationIntent } from "./query-plan.js";
import { assignSourceLocalRanks, rankCodeRegions } from "./ranking.js";
import type { AutoRegionizationResult, AutoRegionizedFile } from "./regionizer.js";
import type { TextScanResult } from "./text-scanner.js";
import type { GrepDisplayLine } from "./types.js";

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
	readonly unit: IndexedCodeUnit;
}

export interface LocalAutoResult {
	readonly regions: readonly CodeRegion[];
	readonly ranked: readonly RankedRegion[];
	readonly totalCandidates: number;
}

/** 普通查询只解析已有文本候选的文件；显式关系查询允许 AST 扫描 scope 作为回退。 */
export function semanticParsePriority(
	inventory: ScopeInventory,
	scan: TextScanResult,
	plan: QueryPlan,
): string[] {
	const evidenceByPath = new Map(scan.fileEvidence.map((item) => [item.path, item]));
	const hitCount = new Map<string, number>();
	for (const hit of scan.hits) hitCount.set(hit.path, (hitCount.get(hit.path) ?? 0) + 1);
	return inventory.files
		.filter((file) => languageFromPath(file.path) !== "text")
		.filter((file) => {
			if (plan.relationIntents.length > 0) return true;
			const evidence = evidenceByPath.get(file.path);
			return (hitCount.get(file.path) ?? 0) > 0 || (evidence?.anchors.length ?? 0) > 0;
		})
		.map((file) => {
			const evidence = evidenceByPath.get(file.path);
			const covered = evidence?.matchedTerms.length ?? 0;
			const phrase = evidence?.anchors.filter((anchor) => anchor.phrase).length ?? 0;
			const identifier = evidence?.anchors.filter((anchor) => anchor.identifier).length ?? 0;
			const exact = hitCount.get(file.path) ?? 0;
			return {
				path: file.path,
				score: exact * 1_000_000 + phrase * 100_000 + identifier * 20_000 + covered * 10_000,
				size: file.snapshot.sizeBytes,
			};
		})
		.sort((left, right) => right.score - left.score || left.size - right.size || compareString(left.path, right.path))
		.map((item) => item.path);
}

/** 文本 hit/anchor 是普通查询的唯一候选来源；AST 只折叠、补充结构并合并。 */
export function buildLocalAutoResults(
	plan: QueryPlan,
	scan: TextScanResult,
	regionized: AutoRegionizationResult,
	displayLimit: number,
): LocalAutoResult {
	const byId = new Map<string, VerifiedCodeRegion | SemanticMainRegion>();
	for (const region of regionized.regions) byId.set(region.id, enrichVerifiedRegion(region, plan));

	const unitFiles = collectUnitFiles(regionized.files);
	const queryTerms = uniqueTerms(plan.targetTerms.length > 0 ? plan.targetTerms : [plan.query]);
	const groupedAnchors = groupLexicalAnchors(scan.fileEvidence, unitFiles);
	const entries = [
		...anchoredUnitCandidates(groupedAnchors.byUnit, unitFiles, plan, queryTerms, displayLimit),
		...lexicalAnchorCandidates(groupedAnchors.outside, scan.hits, plan, queryTerms),
	];
	mergeEntries(byId, entries);
	return rankedResult(plan, byId);
}

/** LSP 没有提供显式关系结果时，才用本次 live AST 生成关系回退。 */
export function applyAstRelationFallback(
	plan: QueryPlan,
	local: LocalAutoResult,
	files: readonly AutoRegionizedFile[],
): LocalAutoResult {
	if (plan.relationIntents.length === 0 || hasRequestedRelation(plan, local.regions)) return local;
	const byId = new Map(local.regions.map((region) => [region.id, region]));
	const units = collectUnitFiles(files);
	const target = lastSegment((plan.targetQuery.length > 0 ? plan.targetQuery : plan.query).toLocaleLowerCase());
	mergeEntries(byId, relationCandidates(units, files, plan, target));
	return rankedResult(plan, byId);
}

function collectUnitFiles(files: readonly AutoRegionizedFile[]): UnitFile[] {
	return files.flatMap((file) => file.analysis.index.units.map((unit) => ({ unit })));
}

function enrichVerifiedRegion(region: VerifiedCodeRegion, plan: QueryPlan): VerifiedCodeRegion {
	const declarationEndByte = region.declarationEndByte;
	const definitionHit = declarationEndByte !== undefined
		&& region.verifiedHits.some((hit) => hit.byteStart < declarationEndByte);
	const roles = definitionHit
		? unique([...region.roles, "definition" as const, ...structuralRoles(region.path, undefined)])
		: region.roles;
	const exactSignal: CandidateSignal = plan.shape === "qualified_symbol"
		? "verified_qualified_occurrence"
		: plan.shape === "identifier"
			? "verified_text"
			: "verified_phrase";
	return { ...region, roles, signals: unique([...region.signals, exactSignal]) };
}

function anchoredUnitCandidates(
	anchorsByUnit: ReadonlyMap<string, readonly LexicalTextAnchor[]>,
	units: readonly UnitFile[],
	plan: QueryPlan,
	queryTerms: readonly string[],
	displayLimit: number,
): LocalEntry[] {
	const result: LocalEntry[] = [];
	for (const item of units) {
		const anchors = anchorsByUnit.get(item.unit.id);
		if (anchors === undefined || anchors.length === 0) continue;
		const anchorTerms = new Set(anchors.flatMap((anchor) => anchor.matchedTerms.map(normalizeTerm)));
		const structureTerms = tokenizeText([
			item.unit.name,
			item.unit.qualifiedName,
			item.unit.signature,
		].filter((value): value is string => value !== undefined).join(" "));
		const matchedTerms = queryTerms.filter((term) => anchorTerms.has(term) || structureTerms.has(term));
		if (!passesCoverage(plan, matchedTerms.length, queryTerms.length)) continue;
		const highCoverage = anchors.some((anchor) => anchor.phrase)
			|| (queryTerms.length > 1 && matchedTerms.length / queryTerms.length >= 0.6);
		const declarationTerms = item.unit.signature === undefined
			? new Set<string>()
			: new Set([...tokenizeText(item.unit.signature).keys()]);
		const displayLines = anchors
			.filter((anchor) => !anchor.matchedTerms.every((term) => declarationTerms.has(normalizeTerm(term))))
			.sort(compareAnchors)
			.slice(0, displayLimit)
			.map(anchorDisplayLine);
		const quality = matchedTerms.length * 1_000
			+ anchors.reduce((score, anchor) => score + anchor.matchedTerms.length * 100 + (anchor.phrase ? 250 : 0), 0)
			- Math.max(0, item.unit.endLine - item.unit.startLine);
		result.push(localEntry(
			item,
			"text-lexical",
			"lexical anchor",
			quality,
			unitRoles(item),
			[highCoverage ? "lexical_high_coverage" : "lexical"],
			displayLines,
		));
	}
	return result;
}

function groupLexicalAnchors(
	evidence: readonly { readonly path: string; readonly anchors: readonly LexicalTextAnchor[] }[],
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
			const enclosing = smallestEnclosingUnit(unitsByPath.get(file.path) ?? [], anchor);
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

function smallestEnclosingUnit(units: readonly UnitFile[], anchor: LexicalTextAnchor): UnitFile | undefined {
	return units
		.filter((item) => item.unit.startLine <= anchor.line && anchor.line <= item.unit.endLine)
		.sort((left, right) => (left.unit.endByte - left.unit.startByte) - (right.unit.endByte - right.unit.startByte)
			|| left.unit.startByte - right.unit.startByte || compareString(left.unit.id, right.unit.id))[0];
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
		result.push({
			id,
			path: anchor.path,
			startLine: anchor.line,
			quality: anchor.matchedTerms.length * 100 + (anchor.phrase ? 100 : 0),
			source: "text-lexical",
			reason: "lexical anchor",
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
				displayLines: [anchorDisplayLine(anchor)],
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
	if (target.length === 0) return [];
	const definitions = new Map<string, UnitFile[]>();
	for (const item of units) for (const definition of item.unit.definitions) {
		const key = definition.toLocaleLowerCase();
		const grouped = definitions.get(key);
		if (grouped === undefined) definitions.set(key, [item]);
		else grouped.push(item);
	}
	const requested = new Set(plan.relationIntents);
	const result: LocalEntry[] = [];
	const add = (
		item: UnitFile,
		role: Extract<CandidateRole, "caller" | "callee" | "reference" | "test" | "registration">,
		intent: RelationIntent,
	): void => {
		if (requested.has(intent)) result.push(localEntry(item, "ast-relation", intent, 100, [role], ["requested_relation"]));
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
	if (requested.has("import")) for (const file of files) for (const imported of file.analysis.imports) {
		if (!imported.specifier.toLocaleLowerCase().includes(target)) continue;
		const id = `${file.file.path}:${imported.startByte}:${imported.endByte}:import`;
		result.push({
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
			}),
		});
	}
	return result;
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
		}),
	};
}

function mergeEntries(
	regions: Map<string, VerifiedCodeRegion | SemanticMainRegion>,
	entries: readonly LocalEntry[],
): void {
	const ranks = assignSourceLocalRanks(entries, (entry) => entry.source, compareLocalEntries);
	for (const entry of entries) addRegion(regions, withEvidence(entry, ranks.get(entry) ?? Number.MAX_SAFE_INTEGER));
}

function rankedResult(
	plan: QueryPlan,
	regions: ReadonlyMap<string, VerifiedCodeRegion | SemanticMainRegion>,
): LocalAutoResult {
	const values = [...regions.values()];
	const ranked = rankCodeRegions(plan, values);
	return { regions: values, ranked, totalCandidates: ranked.length };
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
	const displayLines = existing.queryMatch === "verified"
		? existing.displayLines
		: mergeDisplayLines(existing.displayLines, incoming.displayLines);
	const matchedBy = normalizeMatchedBy(signals, evidence);
	regions.set(existing.id, { ...existing, roles, signals, evidence, displayLines, matchedBy });
}

function withEvidence(entry: LocalEntry, rank: number): SemanticMainRegion {
	const evidence = [{ source: entry.source, rank, confidence: 1, reason: entry.reason }] as const;
	return { ...entry.region, evidence, matchedBy: normalizeMatchedBy(entry.region.signals, evidence) };
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

function mergeDisplayLines(left: readonly GrepDisplayLine[], right: readonly GrepDisplayLine[]): GrepDisplayLine[] {
	const result = new Map<number, GrepDisplayLine>();
	for (const line of [...left, ...right]) if (!result.has(line.line)) result.set(line.line, line);
	return [...result.values()].sort((leftLine, rightLine) => leftLine.line - rightLine.line);
}

function hasRequestedRelation(plan: QueryPlan, regions: readonly CodeRegion[]): boolean {
	const requested = new Set(plan.relationIntents);
	return regions.some((region) =>
		region.signals.includes("requested_relation")
		&& region.roles.some((role) => requested.has(role as RelationIntent)));
}

function passesCoverage(plan: QueryPlan, matched: number, total: number): boolean {
	if (total === 0) return false;
	if (total === 1) return matched === 1;
	const required = plan.shape === "natural_language" || plan.shape === "long_text"
		? Math.max(2, Math.ceil(total * 0.6))
		: Math.min(2, total);
	return matched >= required;
}

function unitRoles(item: UnitFile): CandidateRole[] {
	return ["definition", ...structuralRoles(item.unit.path, item.unit.exported)];
}

function structuralRoles(path: string, exported: boolean | undefined): CandidateRole[] {
	const roles: CandidateRole[] = [];
	if (exported === true) roles.push("public_api");
	if (isTestPath(path)) roles.push("test");
	if (isConfigPath(path)) roles.push("config");
	return roles;
}

function unitMentionsTarget(item: UnitFile, target: string): boolean {
	return item.unit.tokens.has(target)
		|| item.unit.calls.some((call) => lastSegment(call.toLocaleLowerCase()) === target)
		|| item.unit.references.some((reference) => lastSegment(reference.toLocaleLowerCase()) === target);
}

function anchorDisplayLine(anchor: LexicalTextAnchor): GrepDisplayLine {
	const focus = firstTermFocus(anchor.lineText, anchor.matchedTerms);
	return { line: anchor.line, text: compactDisplayLine(anchor.lineText, focus.start, focus.end), type: "evidence" };
}

function compareAnchors(left: LexicalTextAnchor, right: LexicalTextAnchor): number {
	return Number(right.phrase) - Number(left.phrase)
		|| right.matchedTerms.length - left.matchedTerms.length
		|| left.line - right.line;
}

function compareLocalEntries(left: LocalEntry, right: LocalEntry): number {
	return right.quality - left.quality
		|| compareString(left.path, right.path)
		|| left.startLine - right.startLine
		|| compareString(left.id, right.id);
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

function normalizeTerm(value: string): string {
	return value.toLocaleLowerCase();
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function lastSegment(value: string): string {
	return value.split(/[.:#]/u).at(-1) ?? value;
}

function compareString(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

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
import type { QueryPlan } from "./query-plan.js";
import { assignSourceLocalRanks, rankCodeRegions } from "./ranking.js";
import type { RegionizationResult, RegionizedFile } from "./regionizer.js";
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

export interface LocalResult {
	readonly regions: readonly CodeRegion[];
	readonly ranked: readonly RankedRegion[];
}

/** 有正文命中时只解析命中文件；零命中时解析代码 scope，为 related 回退提供 live AST。 */
export function semanticParsePriority(
	inventory: ScopeInventory,
	scan: TextScanResult,
): string[] {
	const evidenceByPath = new Map(scan.fileEvidence.map((item) => [item.path, item]));
	const hitCount = new Map<string, number>();
	for (const hit of scan.hits) hitCount.set(hit.path, (hitCount.get(hit.path) ?? 0) + 1);
	return inventory.files
		.filter((file) => languageFromPath(file.path) !== "text")
		.filter((file) => {
			if (scan.totalHits === 0) return true;
			const evidence = evidenceByPath.get(file.path);
			return (hitCount.get(file.path) ?? 0) > 0 || (evidence?.anchors.length ?? 0) > 0;
		})
		.map((file) => {
			const evidence = evidenceByPath.get(file.path);
			const covered = evidence?.matchedTerms.length ?? 0;
			const phrase = evidence?.anchors.filter((anchor) => anchor.phrase).length ?? 0;
			const exact = hitCount.get(file.path) ?? 0;
			return {
				path: file.path,
				score: exact * 1_000_000 + phrase * 100_000 + covered * 10_000,
				size: file.snapshot.sizeBytes,
			};
		})
		.sort((left, right) => right.score - left.score || left.size - right.size || compareString(left.path, right.path))
		.map((item) => item.path);
}

/** 正文命中优先；仅在整次零命中时将词法 anchor 转成明确标记的 related 候选。 */
export function buildLocalResults(
	plan: QueryPlan,
	scan: TextScanResult,
	regionized: RegionizationResult,
	displayLimit: number,
): LocalResult {
	const byId = new Map<string, VerifiedCodeRegion | SemanticMainRegion>();
	for (const region of regionized.regions) byId.set(region.id, enrichVerifiedRegion(region));
	if (scan.totalHits > 0) return rankedResult(plan, byId);

	const unitFiles = collectUnitFiles(regionized.files);
	const queryTerms = uniqueTerms(plan.targetTerms.length > 0 ? plan.targetTerms : [plan.query]);
	const groupedAnchors = groupLexicalAnchors(scan.fileEvidence, unitFiles);
	const entries = [
		...anchoredUnitCandidates(groupedAnchors.byUnit, unitFiles, queryTerms, displayLimit),
		...lexicalAnchorCandidates(groupedAnchors.outside, scan.hits, queryTerms),
	];
	mergeEntries(byId, entries);
	return rankedResult(plan, byId);
}

function collectUnitFiles(files: readonly RegionizedFile[]): UnitFile[] {
	return files.flatMap((file) => file.analysis.index.units.map((unit) => ({ unit })));
}

function enrichVerifiedRegion(region: VerifiedCodeRegion): VerifiedCodeRegion {
	const declarationEndByte = region.declarationEndByte;
	const definitionHit = declarationEndByte !== undefined
		&& region.verifiedHits.some((hit) => hit.byteStart < declarationEndByte);
	const roles = definitionHit
		? unique([...region.roles, "definition" as const, ...structuralRoles(region.path, undefined)])
		: region.roles;
	return { ...region, roles };
}

function anchoredUnitCandidates(
	anchorsByUnit: ReadonlyMap<string, readonly LexicalTextAnchor[]>,
	units: readonly UnitFile[],
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
		if (!passesCoverage(matchedTerms.length, queryTerms.length)) continue;
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
	queryTerms: readonly string[],
): LocalEntry[] {
	const exactLines = new Set(hits.map((hit) => `${hit.path}\0${hit.line}`));
	const result: LocalEntry[] = [];
	for (const anchor of anchors) {
		if (exactLines.has(`${anchor.path}\0${anchor.line}`)) continue;
		if (!passesCoverage(anchor.matchedTerms.length, queryTerms.length) && !anchor.phrase) continue;
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
	const ranks = assignSourceLocalRanks(
		entries,
		(entry) => entry.source,
		(left, right) => right.quality - left.quality,
		compareLocalEntriesStable,
	);
	for (const entry of entries) addRegion(regions, withEvidence(entry, ranks.get(entry) ?? Number.MAX_SAFE_INTEGER));
}

function rankedResult(
	plan: QueryPlan,
	regions: ReadonlyMap<string, VerifiedCodeRegion | SemanticMainRegion>,
): LocalResult {
	const values = [...regions.values()];
	const ranked = rankCodeRegions(plan, values);
	return { regions: values, ranked };
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

function passesCoverage(matched: number, total: number): boolean {
	if (total === 0) return false;
	if (total === 1) return matched === 1;
	return matched >= Math.max(2, Math.ceil(total * 0.6));
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

function anchorDisplayLine(anchor: LexicalTextAnchor): GrepDisplayLine {
	const focus = firstTermFocus(anchor.lineText, anchor.matchedTerms);
	return { line: anchor.line, text: compactDisplayLine(anchor.lineText, focus.start, focus.end), type: "evidence" };
}

function compareAnchors(left: LexicalTextAnchor, right: LexicalTextAnchor): number {
	return Number(right.phrase) - Number(left.phrase)
		|| right.matchedTerms.length - left.matchedTerms.length
		|| left.line - right.line;
}

function compareLocalEntriesStable(left: LocalEntry, right: LocalEntry): number {
	return compareString(left.path, right.path)
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

function compareString(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

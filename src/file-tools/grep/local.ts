import { compareCodeUnitNesting, createTextTokenMatcher, languageFromPath, tokenizeText, type IndexedCodeUnit } from "../../code-index/parser.js";
import { compactDisplayLine, firstTermFocus } from "./display.js";
import {
	createSemanticCodeRegion,
	type CandidateSignal,
	type CodeRegion,
	type LexicalTextAnchor,
	type RankedRegion,
	type RegionEvidence,
	type SemanticMainRegion,
	type VerifiedCodeRegion,
} from "./candidates.js";
import type { ScopeInventory } from "./inventory.js";
import type { QueryPlan } from "./query-plan.js";
import { rankCodeRegions } from "./ranking.js";
import type { RegionizationResult } from "./regionizer.js";
import type { TextScanResult } from "./text-scanner.js";
import type { GrepDisplayLine } from "./types.js";

interface LocalEntry {
	readonly quality: number;
	readonly region: SemanticMainRegion;
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
		.filter((file) => scan.totalHits === 0
			? evidenceByPath.has(file.path)
			: (hitCount.get(file.path) ?? 0) > 0)
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
export function buildRankedRegions(
	plan: QueryPlan,
	scan: TextScanResult,
	regionized: RegionizationResult,
	displayLimit: number,
): RankedRegion[] {
	const byId = new Map<string, VerifiedCodeRegion | SemanticMainRegion>();
	for (const region of regionized.regions) {
		byId.set(region.id, region.queryMatch === "verified" ? enrichVerifiedRegion(region) : region);
	}
	if (scan.totalHits > 0) return rankCodeRegions(plan, [...byId.values()]);

	const units = regionized.files.flatMap((file) => file.analysis.index.units);
	const queryTerms = uniqueTerms(plan.targetTerms.length > 0 ? plan.targetTerms : [plan.query]);
	const groupedAnchors = groupLexicalAnchors(scan.fileEvidence, units);
	const entries = [
		...anchoredUnitCandidates(groupedAnchors.byUnit, units, queryTerms, displayLimit),
		...lexicalAnchorCandidates(groupedAnchors.outside, scan.hits, queryTerms),
	];
	mergeEntries(byId, entries);
	return rankCodeRegions(plan, [...byId.values()]);
}

function enrichVerifiedRegion(region: VerifiedCodeRegion): VerifiedCodeRegion {
	const declarationEndByte = region.declarationEndByte;
	const definitionHit = declarationEndByte !== undefined
		&& region.verifiedHits.some((hit) => hit.byteStart < declarationEndByte);
	return definitionHit ? { ...region, symbolRole: "definition" } : region;
}

function anchoredUnitCandidates(
	anchorsByUnit: ReadonlyMap<string, readonly LexicalTextAnchor[]>,
	units: readonly IndexedCodeUnit[],
	queryTerms: readonly string[],
	displayLimit: number,
): LocalEntry[] {
	const result: LocalEntry[] = [];
	const matchTerms = createTextTokenMatcher(queryTerms);
	for (const item of units) {
		const anchors = anchorsByUnit.get(item.id);
		if (anchors === undefined || anchors.length === 0) continue;
		const anchorTerms = new Set(anchors.flatMap((anchor) => anchor.matchedTerms.map(normalizeTerm)));
		const declarationTerms = new Set(matchTerms(item.signature ?? ""));
		const structureTerms = new Set([
			...declarationTerms,
			...matchTerms([item.name, item.qualifiedName].filter((value): value is string => value !== undefined).join(" ")),
		]);
		const matchedTerms = queryTerms.filter((term) => anchorTerms.has(term) || structureTerms.has(term));
		if (!passesCoverage(matchedTerms.length, queryTerms.length)) continue;
		const highCoverage = anchors.some((anchor) => anchor.phrase)
			|| (queryTerms.length > 1 && matchedTerms.length / queryTerms.length >= 0.6);
		const displayLines = anchors
			.filter((anchor) => !anchor.matchedTerms.every((term) => declarationTerms.has(normalizeTerm(term))))
			.sort(compareAnchors)
			.slice(0, displayLimit)
			.map(anchorDisplayLine);
		const quality = matchedTerms.length * 1_000
			+ anchors.reduce((score, anchor) => score + anchor.matchedTerms.length * 100 + (anchor.phrase ? 250 : 0), 0)
			- Math.max(0, item.endLine - item.startLine);
		result.push(localEntry(
			item,
			quality,
			[highCoverage ? "lexical_high_coverage" : "lexical"],
			displayLines,
		));
	}
	return result;
}

function groupLexicalAnchors(
	evidence: readonly { readonly path: string; readonly anchors: readonly LexicalTextAnchor[] }[],
	units: readonly IndexedCodeUnit[],
): { readonly byUnit: ReadonlyMap<string, readonly LexicalTextAnchor[]>; readonly outside: readonly LexicalTextAnchor[] } {
	const unitsByPath = new Map<string, IndexedCodeUnit[]>();
	for (const item of units) {
		const grouped = unitsByPath.get(item.path);
		if (grouped === undefined) unitsByPath.set(item.path, [item]);
		else grouped.push(item);
	}
	for (const grouped of unitsByPath.values()) {
		grouped.sort(compareCodeUnitNesting);
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
			const grouped = byUnit.get(enclosing.id);
			if (grouped === undefined) byUnit.set(enclosing.id, [anchor]);
			else grouped.push(anchor);
		}
	}
	return { byUnit, outside };
}

function smallestEnclosingUnit(units: readonly IndexedCodeUnit[], anchor: LexicalTextAnchor): IndexedCodeUnit | undefined {
	return units.find((item) => item.startLine <= anchor.line && anchor.line <= item.endLine);
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
			quality: anchor.matchedTerms.length * 100 + (anchor.phrase ? 100 : 0),
			region: createSemanticCodeRegion({
				id,
				path: anchor.path,
				startLine: anchor.line,
				endLine: anchor.line,
				startByte: anchor.byteStart,
				endByte: anchor.byteEnd,
				kind: "text",
				signals: [highCoverage ? "lexical_high_coverage" : "lexical"],
				displayLines: [anchorDisplayLine(anchor)],
			}),
		});
	}
	return result;
}

function localEntry(
	item: IndexedCodeUnit,
	quality: number,
	signals: readonly CandidateSignal[],
	displayLines: readonly GrepDisplayLine[] = [],
): LocalEntry {
	return {
		quality,
		region: createSemanticCodeRegion({
			id: item.id,
			path: item.path,
			startLine: item.startLine,
			endLine: item.endLine,
			startByte: item.startByte,
			endByte: item.endByte,
			kind: item.kind,
			...(item.name === undefined ? {} : { symbol: item.qualifiedName ?? item.name }),
			...(item.qualifiedName === undefined ? {} : { qualifiedSymbol: item.qualifiedName }),
			...(item.signature === undefined ? {} : { declaration: item.signature }),
			...(item.declarationEndByte === undefined ? {} : { declarationEndByte: item.declarationEndByte }),
			symbolRole: "definition",
			authority: item.authority,
			signals,
			displayLines,
		}),
	};
}

function mergeEntries(
	regions: Map<string, VerifiedCodeRegion | SemanticMainRegion>,
	entries: readonly LocalEntry[],
): void {
	const sorted = [...entries].sort((left, right) =>
		right.quality - left.quality || compareLocalEntriesStable(left, right));
	const ranks = new Map<LocalEntry, number>();
	let rank = 0;
	let previousQuality: number | undefined;
	for (const entry of sorted) {
		if (previousQuality === undefined || entry.quality !== previousQuality) rank += 1;
		ranks.set(entry, rank);
		previousQuality = entry.quality;
	}
	for (const entry of entries) addRegion(regions, withEvidence(entry, ranks.get(entry) ?? Number.MAX_SAFE_INTEGER));
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
	const signals = unique([...existing.signals, ...incoming.signals]);
	const evidence = mergeEvidence(existing.evidence, incoming.evidence);
	const displayLines = existing.queryMatch === "verified"
		? existing.displayLines
		: mergeDisplayLines(existing.displayLines, incoming.displayLines);
	const symbolRole = existing.symbolRole ?? incoming.symbolRole;
	const authority = strongerAuthority(existing.authority, incoming.authority);
	regions.set(existing.id, {
		...existing,
		...(symbolRole === undefined ? {} : { symbolRole }),
		...(authority === undefined ? {} : { authority }),
		signals,
		...(evidence === undefined ? {} : { evidence }),
		displayLines,
	});
}

function withEvidence(entry: LocalEntry, rank: number): SemanticMainRegion {
	const evidence = { source: "text-lexical", rank } as const;
	return { ...entry.region, evidence };
}

function mergeEvidence(left: RegionEvidence | undefined, right: RegionEvidence | undefined): RegionEvidence | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return left.rank <= right.rank ? left : right;
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
	return compareString(left.region.path, right.region.path)
		|| left.region.startLine - right.region.startLine
		|| compareString(left.region.id, right.region.id);
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

function strongerAuthority(
	left: CodeRegion["authority"],
	right: CodeRegion["authority"],
): CodeRegion["authority"] {
	const priority = { called: 0, referenced: 1, defined: 2 } as const;
	if (left === undefined) return right;
	if (right === undefined) return left;
	return priority[left] <= priority[right] ? left : right;
}

function compareString(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

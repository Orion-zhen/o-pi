import { byteRangeForLines, extractByteRange, splitTokens, tokenizeText, type IndexedCodeUnit } from "./parser.js";
import type { GrepMatchMode } from "../types.js";

export interface RankedGrepRegion {
	id: string;
	path: string;
	kind: string;
	startLine: number;
	endLine: number;
	startByte: number;
	endByte: number;
	symbol?: string;
	signature?: string;
	score: number;
	reasons: string[];
	matchLines: number[];
	unit?: IndexedCodeUnit;
	callers: string[];
	callees: string[];
	imports: string[];
}

export interface RankInput {
	query: string;
	match: GrepMatchMode;
	files: Array<{ path: string; units: IndexedCodeUnit[] }>;
	sourceText?: Map<string, string>;
	regex?: RegExp;
	allowMetadataCandidates?: boolean;
}

const IDENTIFIER_LIKE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u;

/** 合并 symbol、literal/regex、词法和一跳关系候选，返回稳定排序后的代码区域。 */
export function rankGrepRegions(input: RankInput): { regions: RankedGrepRegion[]; strategy: string[]; nearSymbols: string[] } {
	const strategy = strategiesFor(input);
	const candidates = new Map<string, RankedGrepRegion>();
	const allUnits = input.files.flatMap((file) => file.units);
	const seedSymbols = new Set<string>();

	for (const unit of allUnits) {
		const ranked = rankUnit(unit, input, allUnits.length);
		if (ranked.score > 0) {
			addCandidate(candidates, ranked);
			if (ranked.reasons.some((reason) => reason === "exact symbol" || reason === "exact qualified symbol" || reason === "definition")) {
				for (const definition of unit.definitions) seedSymbols.add(definition);
				if (unit.name !== undefined) seedSymbols.add(unit.name);
			}
		}
	}

	if (input.match !== "auto") {
		for (const fallback of rankFallbackText(input)) addCandidate(candidates, fallback);
	}

	if (input.match === "auto" && seedSymbols.size > 0) {
		for (const relation of relationCandidates(allUnits, seedSymbols)) addCandidate(candidates, relation);
	}

	const queryMentionsTests = /\b(test|spec)\b/iu.test(input.query);
	const sorted = Array.from(candidates.values()).sort((left, right) => compareRanked(left, right, queryMentionsTests));
	return {
		regions: sorted,
		strategy,
		nearSymbols: sorted.length === 0 ? nearSymbols(input.query, allUnits) : [],
	};
}

function rankUnit(unit: IndexedCodeUnit, input: RankInput, corpusSize: number): RankedGrepRegion {
	const reasons: string[] = [];
	let score = 0;
	const query = input.query;
	const queryLower = query.toLocaleLowerCase();
	const symbol = unit.qualifiedName ?? unit.name;
	if (input.match === "auto") {
		if (unit.qualifiedName?.toLocaleLowerCase() === queryLower) {
			score += 1000;
			reasons.push("exact qualified symbol", "definition");
		} else if (unit.name?.toLocaleLowerCase() === queryLower) {
			score += 900;
			reasons.push("exact symbol", "definition");
		} else if (symbol !== undefined && isFuzzySymbolMatch(symbol, query)) {
			score += IDENTIFIER_LIKE.test(query) ? 650 : 180;
			reasons.push("symbol prefix");
		}
		const lexical = bm25(unit, input.query, corpusSize);
		if (lexical > 0 && hasEnoughLexicalCoverage(unit, input.query)) {
			score += lexical;
			reasons.push("lexical");
		}
		if (pathRelevance(unit.path, query) > 0) {
			score += pathRelevance(unit.path, query);
			reasons.push("path");
		}
	}

	const occurrence = occurrenceLines(unit, input);
	if (occurrence.length > 0) {
		score += input.match === "auto" ? literalWeight(query) : 1000;
		reasons.push(input.match === "regex" ? "regex" : "exact literal");
	} else if (input.match !== "auto" && input.allowMetadataCandidates === true && metadataLooksRelevant(unit, input)) {
		score += input.match === "regex" ? 420 : 520;
		reasons.push("lexical");
	}
	if (unit.definitions.some((definition) => definition.toLocaleLowerCase() === queryLower)) {
		score += 100;
		if (!reasons.includes("definition")) reasons.push("definition");
	}
	return makeRegion(unit, score, reasons, occurrence);
}

function rankFallbackText(input: RankInput): RankedGrepRegion[] {
	const regions: RankedGrepRegion[] = [];
	for (const file of input.files) {
		const text = input.sourceText?.get(file.path);
		if (text === undefined) continue;
		const matchedLines = matchLinesInText(text, input);
		for (const line of matchedLines) {
			if (file.units.some((unit) => line >= unit.startLine && line <= unit.endLine)) continue;
			const range = byteRangeForLines(text, Math.max(1, line - 2), line + 2);
			regions.push({
				id: `${file.path}:${range.startByte}:${range.endByte}:fallback`,
				path: file.path,
				kind: "text",
				startLine: Math.max(1, line - 2),
				endLine: line + 2,
				startByte: range.startByte,
				endByte: range.endByte,
				score: 500,
				reasons: [input.match === "regex" ? "regex" : "exact literal"],
				matchLines: [line],
				callers: [],
				callees: [],
				imports: [],
			});
		}
	}
	return regions;
}

function relationCandidates(units: IndexedCodeUnit[], seedSymbols: Set<string>): RankedGrepRegion[] {
	const byDefinition = new Map<string, IndexedCodeUnit>();
	for (const unit of units) {
		for (const definition of unit.definitions) {
			if (!byDefinition.has(definition)) byDefinition.set(definition, unit);
		}
	}
	const result: RankedGrepRegion[] = [];
	for (const unit of units) {
		const symbol = unit.name ?? unit.qualifiedName;
		const callsSeed = unit.calls.some((call) => seedSymbols.has(lastSegment(call)));
		if (callsSeed) result.push(makeRegion(unit, 260, ["caller"], []));
		for (const call of unit.calls) {
			const callee = byDefinition.get(lastSegment(call));
			if (callee !== undefined && seedSymbols.has(unit.name ?? "")) result.push(makeRegion(callee, 240, ["callee"], []));
		}
		if (symbol !== undefined && unit.imports.some((item) => Array.from(seedSymbols).some((seed) => item.includes(seed)))) {
			result.push(makeRegion(unit, 180, ["import"], []));
		}
	}
	return result;
}

function makeRegion(unit: IndexedCodeUnit, score: number, reasons: string[], matchLines: number[]): RankedGrepRegion {
	return {
		id: unit.id,
		path: unit.path,
		kind: unit.kind,
		startLine: unit.startLine,
		endLine: unit.endLine,
		startByte: unit.startByte,
		endByte: unit.endByte,
		...(unit.qualifiedName ?? unit.name ? { symbol: unit.qualifiedName ?? unit.name } : {}),
		...(unit.signature !== undefined ? { signature: unit.signature } : {}),
		score,
		reasons: Array.from(new Set(reasons)),
		matchLines,
		unit,
		callers: [],
		callees: unit.calls.slice(0, 6),
		imports: unit.imports.slice(0, 4),
	};
}

function occurrenceLines(unit: IndexedCodeUnit, input: RankInput): number[] {
	if (input.match === "auto" || input.match === "literal" || input.match === "regex") {
		const text = input.sourceText?.get(unit.path);
		if (text === undefined) return [];
		const content = extractByteRange(text, unit.startByte, unit.endByte);
		const lines = matchLinesInText(content, input).map((line) => line + unit.startLine - 1);
		return Array.from(new Set(lines));
	}
	return [];
}

function metadataLooksRelevant(unit: IndexedCodeUnit, input: RankInput): boolean {
	const values = [
		unit.name,
		unit.qualifiedName,
		unit.signature,
		...unit.definitions,
		...unit.references,
		...unit.calls,
		...unit.imports,
		...unit.tokens.keys(),
	].filter((value): value is string => value !== undefined);
	if (input.match === "regex") return values.some((value) => regexMatches(value, input.regex));
	const queryTokens = splitTokens(input.query).map((token) => token.toLocaleLowerCase());
	if (queryTokens.length === 0) return values.some((value) => value.includes(input.query));
	const tokenSet = new Set(Array.from(unit.tokens.keys()));
	return queryTokens.some((token) => tokenSet.has(token));
}

function regexMatches(value: string, regex: RegExp | undefined): boolean {
	if (regex === undefined) return false;
	const matched = regex.test(value);
	if (regex.global) regex.lastIndex = 0;
	return matched;
}

function matchLinesInText(text: string, input: RankInput): number[] {
	const lines = text.split(/\n/u);
	const result: number[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (input.match === "regex") {
			if (input.regex?.test(line) === true) {
				result.push(index + 1);
				if (input.regex.global) input.regex.lastIndex = 0;
			}
		} else if (line.includes(input.query)) {
			result.push(index + 1);
		}
	}
	return result;
}

function bm25(unit: IndexedCodeUnit, query: string, corpusSize: number): number {
	const queryTokens = splitTokens(query).map((token) => token.toLocaleLowerCase());
	if (queryTokens.length === 0) return 0;
	const length = Array.from(unit.tokens.values()).reduce((sum, count) => sum + count, 0);
	let score = 0;
	for (const token of queryTokens) {
		const tf = unit.tokens.get(token) ?? 0;
		if (tf === 0) continue;
		const dfEstimate = Math.max(1, Math.min(corpusSize, Math.ceil(corpusSize / (1 + tf))));
		const idf = Math.log(1 + (corpusSize - dfEstimate + 0.5) / (dfEstimate + 0.5));
		score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (length / 80))));
	}
	return score * 120;
}

function hasEnoughLexicalCoverage(unit: IndexedCodeUnit, query: string): boolean {
	const tokens = splitTokens(query).map((token) => token.toLocaleLowerCase());
	if (tokens.length <= 1 || IDENTIFIER_LIKE.test(query)) return true;
	let matched = 0;
	for (const token of new Set(tokens)) {
		if (unit.tokens.has(token)) matched += 1;
	}
	return matched >= Math.min(2, tokens.length);
}

function nearSymbols(query: string, units: IndexedCodeUnit[]): string[] {
	const queryTokens = tokenizeText(query);
	return units
		.map((unit) => ({ unit, score: tokenOverlap(queryTokens, unit.tokens) }))
		.filter((item) => item.score > 0 && (item.unit.qualifiedName ?? item.unit.name) !== undefined)
		.sort((left, right) => right.score - left.score || compareStableString(left.unit.path, right.unit.path))
		.slice(0, 6)
		.map((item) => item.unit.qualifiedName ?? item.unit.name)
		.filter((value): value is string => value !== undefined);
}

function tokenOverlap(left: Map<string, number>, right: Map<string, number>): number {
	let score = 0;
	for (const token of left.keys()) {
		if (right.has(token)) score += 1;
	}
	return score;
}

function strategiesFor(input: RankInput): string[] {
	if (input.match === "literal") return ["literal"];
	if (input.match === "regex") return ["regex"];
	return IDENTIFIER_LIKE.test(input.query) ? ["symbol", "literal", "lexical", "graph"] : ["literal", "lexical", "graph"];
}

function isFuzzySymbolMatch(symbol: string, query: string): boolean {
	const symbolLower = symbol.toLocaleLowerCase();
	const queryLower = query.toLocaleLowerCase();
	return symbolLower.startsWith(queryLower) || symbolLower.includes(queryLower) || splitTokens(symbol).some((token) => token.toLocaleLowerCase() === queryLower);
}

function literalWeight(query: string): number {
	if (query.includes(" ") || query.includes(":") || query.includes("=")) return 520;
	if (IDENTIFIER_LIKE.test(query)) return 260;
	return 420;
}

function pathRelevance(filePath: string, query: string): number {
	const pathTokens = tokenizeText(filePath);
	return tokenOverlap(tokenizeText(query), pathTokens) * 35;
}

function compareRanked(left: RankedGrepRegion, right: RankedGrepRegion, queryMentionsTests: boolean): number {
	const score = adjustedScore(right, queryMentionsTests) - adjustedScore(left, queryMentionsTests);
	if (score !== 0) return score;
	const path = compareStableString(left.path, right.path);
	if (path !== 0) return path;
	return left.startLine - right.startLine || left.endLine - right.endLine;
}

function adjustedScore(region: RankedGrepRegion, queryMentionsTests: boolean): number {
	const testPenalty = !queryMentionsTests && /(^|\/)(test|tests|__tests__|spec)\b|[._-](test|spec)\./iu.test(region.path) ? 180 : 0;
	return region.score - testPenalty;
}

function addCandidate(candidates: Map<string, RankedGrepRegion>, candidate: RankedGrepRegion): void {
	const existing = candidates.get(candidate.id);
	if (existing === undefined || candidate.score > existing.score) {
		candidates.set(candidate.id, candidate);
		return;
	}
	for (const reason of candidate.reasons) {
		if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
	}
	for (const line of candidate.matchLines) {
		if (!existing.matchLines.includes(line)) existing.matchLines.push(line);
	}
}

function lastSegment(value: string): string {
	return value.split(".").at(-1) ?? value;
}

function compareStableString(left: string | undefined, right: string | undefined): number {
	const a = left ?? "";
	const b = right ?? "";
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

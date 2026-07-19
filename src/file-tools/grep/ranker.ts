import { buildLineIndex, byteRangeForLinesWithIndex, extractByteRange, splitTokens, tokenizeText, type AnalyzedFileIndex, type IndexedCodeUnit, type LineIndex, type SourceRange } from "../../code-index/parser.js";
import { createRankingEvidence, EMPTY_RANKING_EVIDENCE, mergeRankingEvidence, rankPercentile, type RankingEvidence, type RankingEvidenceFamily } from "../ranking-evidence.js";
import type { GrepMatchMode } from "../types.js";

export interface RankedGrepRegion extends SourceRange {
	id: string;
	path: string;
	kind: string;
	symbol?: string;
	signature?: string;
	tier: number;
	evidence: RankingEvidence;
	reasons: string[];
	matchLines: number[];
	unit?: IndexedCodeUnit;
	callees: string[];
	imports: string[];
	repoMap?: true;
	lexicalRelevance: number;
	pathRelevance: number;
}

export interface RankInput {
	query: string;
	match: GrepMatchMode;
	files: Array<{ path: string; units: IndexedCodeUnit[]; parserStatus: AnalyzedFileIndex["status"] }>;
	sourceText?: Map<string, string>;
	lineIndexes?: Map<string, LineIndex>;
	regex?: RegExp;
	allowMetadataCandidates?: boolean;
}

interface RankContext {
	queryLower: string;
	queryTokens: string[];
	queryTokenMap: Map<string, number>;
	identifierLike: boolean;
	corpusSize: number;
}

const IDENTIFIER_LIKE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u;

/** 合并 symbol、literal/regex、词法和一跳关系候选，返回稳定排序后的代码区域。 */
export function rankGrepRegions(input: RankInput): { regions: RankedGrepRegion[]; strategy: string[]; nearSymbols: string[] } {
	const strategy = strategiesFor(input);
	const candidates = new Map<string, RankedGrepRegion>();
	const allUnits = input.files.flatMap((file) => file.units);
	const seedSymbols = new Set<string>();
	const queryTokens = splitTokens(input.query).map((token) => token.toLocaleLowerCase());
	const context: RankContext = {
		queryLower: input.query.toLocaleLowerCase(),
		queryTokens,
		queryTokenMap: tokenizeText(input.query),
		identifierLike: IDENTIFIER_LIKE.test(input.query),
		corpusSize: allUnits.length,
	};

	for (const unit of allUnits) {
		const ranked = rankUnit(unit, input, context);
		if (ranked.reasons.length > 0) {
			addCandidate(candidates, ranked);
			if (ranked.reasons.some((reason) => reason === "exact symbol" || reason === "exact qualified symbol" || reason === "definition")) {
				for (const definition of unit.definitions) seedSymbols.add(definition);
				if (unit.name !== undefined) seedSymbols.add(unit.name);
			}
		}
	}

	if (input.match === "auto") {
		for (const fallback of rankAutoFallbackText(input, context)) addCandidate(candidates, fallback);
	} else {
		for (const fallback of rankFallbackText(input)) addCandidate(candidates, fallback);
	}

	if (input.match === "auto" && seedSymbols.size > 0) {
		for (const relation of relationCandidates(allUnits, seedSymbols)) addCandidate(candidates, relation);
	}

	const sourceSorted = Array.from(candidates.values()).sort(compareLocalRanked);
	for (const [index, region] of sourceSorted.entries()) {
		region.evidence = createRankingEvidence(localEvidenceFamily(region), rankPercentile(index, sourceSorted.length));
	}
	return {
		regions: sourceSorted,
		strategy,
		nearSymbols: sourceSorted.length === 0 ? nearSymbols(input.query, allUnits) : [],
	};
}

function localEvidenceFamily(region: RankedGrepRegion): RankingEvidenceFamily {
	return region.reasons.some((reason) =>
		reason === "exact qualified symbol"
		|| reason === "exact symbol"
		|| reason === "definition"
		|| reason === "symbol prefix")
		? "structural"
		: "lexical";
}

function rankUnit(unit: IndexedCodeUnit, input: RankInput, context: RankContext): RankedGrepRegion {
	const reasons: string[] = [];
	let lexicalRelevance = 0;
	let pathScore = 0;
	const query = input.query;
	const symbol = unit.qualifiedName ?? unit.name;
	if (input.match === "auto") {
		if (unit.qualifiedName?.toLocaleLowerCase() === context.queryLower) {
			reasons.push("exact qualified symbol", "definition");
		} else if (unit.name?.toLocaleLowerCase() === context.queryLower) {
			reasons.push("exact symbol", "definition");
		} else if (symbol !== undefined && isFuzzySymbolMatch(symbol, query)) {
			reasons.push("symbol prefix");
		}
		const lexical = bm25(unit, context.queryTokens, context.corpusSize);
		if (lexical > 0 && hasEnoughLexicalCoverage(unit, context.queryTokens, context.identifierLike)) {
			lexicalRelevance = lexical;
			reasons.push("lexical");
		}
		pathScore = pathRelevance(unit.path, context.queryTokenMap);
		if (pathScore > 0) {
			reasons.push("path");
		}
	}

	const occurrence = occurrenceLines(unit, input);
	if (occurrence.length > 0) {
		reasons.push(input.match === "regex" ? "regex" : "exact literal");
	} else if (input.match !== "auto" && input.allowMetadataCandidates === true && metadataLooksRelevant(unit, input, context.queryTokens)) {
		reasons.push("lexical");
	}
	if (unit.definitions.some((definition) => definition.toLocaleLowerCase() === context.queryLower)) {
		if (!reasons.includes("definition")) reasons.push("definition");
	}
	return makeRegion(unit, evidenceTier(input, unit, reasons, occurrence), reasons, occurrence, lexicalRelevance, pathScore);
}

function rankFallbackText(input: RankInput): RankedGrepRegion[] {
	const regions: RankedGrepRegion[] = [];
	for (const file of input.files) {
		const text = input.sourceText?.get(file.path);
		if (text === undefined) continue;
		const matchedLines = matchLinesInText(text, input);
		let lineIndex = input.lineIndexes?.get(file.path);
		if (lineIndex === undefined) {
			lineIndex = buildLineIndex(text);
			input.lineIndexes?.set(file.path, lineIndex);
		}
		for (const line of matchedLines) {
			if (file.units.some((unit) => line >= unit.startLine && line <= unit.endLine)) continue;
			const range = byteRangeForLinesWithIndex(lineIndex, Math.max(1, line - 2), line + 2);
			regions.push({
				id: `${file.path}:${range.startByte}:${range.endByte}:fallback`,
				path: file.path,
				kind: "text",
				startLine: Math.max(1, line - 2),
				endLine: line + 2,
				startByte: range.startByte,
				endByte: range.endByte,
				tier: 2,
				evidence: EMPTY_RANKING_EVIDENCE,
				reasons: [input.match === "regex" ? "regex" : "exact literal"],
				matchLines: [line],
				callees: [],
				imports: [],
				lexicalRelevance: 0,
				pathRelevance: 0,
			});
		}
	}
	return regions;
}

function rankAutoFallbackText(input: RankInput, context: RankContext): RankedGrepRegion[] {
	const regions: RankedGrepRegion[] = [];
	const queryTokens = [...new Set(context.queryTokens)];
	for (const file of input.files) {
		if (file.parserStatus === "parsed") continue;
		const text = input.sourceText?.get(file.path);
		if (text === undefined) continue;
		const lines = text.split(/\n/u);
		const pathScore = pathRelevance(file.path, context.queryTokenMap);
		let lineIndex = input.lineIndexes?.get(file.path);
		if (lineIndex === undefined) {
			lineIndex = buildLineIndex(text);
			input.lineIndexes?.set(file.path, lineIndex);
		}
		for (const [index, content] of lines.entries()) {
			const exact = content.includes(input.query);
			const identifierMatch = context.identifierLike && content.toLocaleLowerCase().includes(context.queryLower);
			if (!exact && context.identifierLike && !identifierMatch) continue;
			const matchedTokens = countMatchedTokens(queryTokens, tokenizeText(content));
			const lexicalMatch = context.identifierLike ? identifierMatch : hasFallbackLexicalCoverage(matchedTokens, queryTokens.length);
			if (!exact && !lexicalMatch) continue;
			const line = index + 1;
			const range = byteRangeForLinesWithIndex(lineIndex, Math.max(1, line - 2), line + 2);
			regions.push({
				id: `${file.path}:${range.startByte}:${range.endByte}:auto-fallback`,
				path: file.path,
				kind: "text",
				startLine: Math.max(1, line - 2),
				endLine: line + 2,
				startByte: range.startByte,
				endByte: range.endByte,
				tier: exact ? 4 : 5,
				evidence: EMPTY_RANKING_EVIDENCE,
				reasons: [exact ? "exact literal" : "lexical"],
				matchLines: [line],
				callees: [],
				imports: [],
				lexicalRelevance: matchedTokens,
				pathRelevance: pathScore,
			});
		}
	}
	return regions;
}

function countMatchedTokens(queryTokens: readonly string[], contentTokens: ReadonlyMap<string, number>): number {
	let matched = 0;
	for (const token of queryTokens) if (contentTokens.has(token)) matched += 1;
	return matched;
}

function hasFallbackLexicalCoverage(matched: number, total: number): boolean {
	if (total === 0) return false;
	return matched >= (total === 1 ? 1 : Math.min(2, total));
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
		if (callsSeed) result.push(makeRegion(unit, 6, ["caller"], [], 0, 0));
		for (const call of unit.calls) {
			const callee = byDefinition.get(lastSegment(call));
			if (callee !== undefined && seedSymbols.has(unit.name ?? "")) result.push(makeRegion(callee, 6, ["callee"], [], 0, 0));
		}
		if (symbol !== undefined && unit.imports.some((item) => containsAny(item, seedSymbols))) {
			result.push(makeRegion(unit, 6, ["import"], [], 0, 0));
		}
	}
	return result;
}

function containsAny(value: string, candidates: ReadonlySet<string>): boolean {
	for (const candidate of candidates) if (value.includes(candidate)) return true;
	return false;
}

function makeRegion(
	unit: IndexedCodeUnit,
	tier: number,
	reasons: string[],
	matchLines: number[],
	lexicalRelevance: number,
	pathScore: number,
): RankedGrepRegion {
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
		tier,
		evidence: EMPTY_RANKING_EVIDENCE,
		reasons: Array.from(new Set(reasons)),
		matchLines,
		unit,
		callees: reasons.includes("caller") ? unit.calls.slice(0, 6) : [],
		imports: reasons.includes("import") ? unit.imports.slice(0, 4) : [],
		lexicalRelevance,
		pathRelevance: pathScore,
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

function metadataLooksRelevant(unit: IndexedCodeUnit, input: RankInput, queryTokens: string[]): boolean {
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

function bm25(unit: IndexedCodeUnit, queryTokens: string[], corpusSize: number): number {
	if (queryTokens.length === 0) return 0;
	let length = 0;
	for (const count of unit.tokens.values()) length += count;
	let score = 0;
	for (const token of queryTokens) {
		const tf = unit.tokens.get(token) ?? 0;
		if (tf === 0) continue;
		const dfEstimate = Math.max(1, Math.min(corpusSize, Math.ceil(corpusSize / (1 + tf))));
		const idf = Math.log(1 + (corpusSize - dfEstimate + 0.5) / (dfEstimate + 0.5));
		score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (length / 80))));
	}
	return score;
}

function hasEnoughLexicalCoverage(unit: IndexedCodeUnit, tokens: string[], identifierLike: boolean): boolean {
	if (tokens.length <= 1 || identifierLike) return true;
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

function pathRelevance(filePath: string, queryTokens: Map<string, number>): number {
	const pathTokens = tokenizeText(filePath);
	return tokenOverlap(queryTokens, pathTokens);
}

function compareLocalRanked(left: RankedGrepRegion, right: RankedGrepRegion): number {
	return left.tier - right.tier
		|| right.lexicalRelevance - left.lexicalRelevance
		|| right.matchLines.length - left.matchLines.length
		|| right.pathRelevance - left.pathRelevance
		|| (left.endLine - left.startLine) - (right.endLine - right.startLine)
		|| compareStableString(left.path, right.path)
		|| left.startLine - right.startLine
		|| left.endLine - right.endLine;
}

function addCandidate(candidates: Map<string, RankedGrepRegion>, candidate: RankedGrepRegion): void {
	const existing = candidates.get(candidate.id);
	if (existing === undefined) {
		candidates.set(candidate.id, candidate);
		return;
	}
	existing.tier = Math.min(existing.tier, candidate.tier);
	existing.lexicalRelevance = Math.max(existing.lexicalRelevance, candidate.lexicalRelevance);
	existing.pathRelevance = Math.max(existing.pathRelevance, candidate.pathRelevance);
	existing.evidence = mergeRankingEvidence(existing.evidence, candidate.evidence);
	for (const reason of candidate.reasons) {
		if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
	}
	for (const line of candidate.matchLines) {
		if (!existing.matchLines.includes(line)) existing.matchLines.push(line);
	}
}

function evidenceTier(input: RankInput, unit: IndexedCodeUnit, reasons: string[], matchLines: number[]): number {
	if (input.match !== "auto") {
		if (matchLines.length === 0) return 5;
		if (symbolMatches(unit, input)) return 0;
		return 1;
	}
	if (reasons.includes("exact qualified symbol")) return 1;
	if (reasons.includes("exact symbol") || reasons.includes("definition")) return 3;
	if (reasons.includes("symbol prefix") || reasons.includes("exact literal")) return 4;
	if (reasons.includes("lexical") || reasons.includes("path")) return 5;
	return 6;
}

function symbolMatches(unit: IndexedCodeUnit, input: RankInput): boolean {
	const values = [unit.name, unit.qualifiedName, unit.signature].filter((value): value is string => value !== undefined);
	if (input.match === "regex") return values.some((value) => regexMatches(value, input.regex));
	return values.some((value) => value.includes(input.query));
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

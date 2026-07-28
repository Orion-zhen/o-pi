import { tokenizeText, tokenizeTextSequence } from "../../code-index/parser.js";
import type { IndexedCodeUnit } from "../../code-index/parser.js";
import type { LexicalTextAnchor } from "./candidates.js";
import { isErrorLikeQuery, type QueryPlan } from "./query-plan.js";

const BM25_K1 = 1.2;

type LexicalField = "symbol" | "signature" | "path" | "code" | "comment" | "string";

interface FieldFacts {
	readonly text: string;
	readonly tokens: ReadonlyMap<string, number>;
	readonly length: number;
}

interface RegionFacts {
	readonly fields: Readonly<Record<LexicalField, FieldFacts>>;
	readonly sequence: readonly string[];
	readonly lineSequences: readonly (readonly string[])[];
	readonly regionLength: number;
}

interface ScopeStatistics {
	readonly documentCount: number;
	readonly averageLengths: Readonly<Record<LexicalField, number>>;
	readonly documentFrequency: ReadonlyMap<string, number>;
}

export interface LexicalScoringRegion {
	readonly unit: IndexedCodeUnit;
	readonly content: string;
	readonly anchors: readonly LexicalTextAnchor[];
}

export interface LexicalEvidenceLine {
	readonly line: number;
	readonly text: string;
	readonly matchedTerms: readonly string[];
}

export interface LexicalRegionScore {
	readonly quality: number;
	readonly matchedTerms: readonly string[];
	readonly exactTokenCoverage: number;
	readonly expandedCoverage: number;
	readonly highCoverage: boolean;
	readonly evidenceLines: readonly LexicalEvidenceLine[];
}

interface WeightedField {
	readonly weight: number;
	readonly b: number;
}

/** 在当前已解析 scope 内计算轻量 BM25F 与位置特征。 */
export function scoreLexicalRegions(
	regions: readonly LexicalScoringRegion[],
	plan: QueryPlan,
	queryTerms: readonly string[],
): ReadonlyMap<string, LexicalRegionScore> {
	const terms = unique(queryTerms.map(normalizeToken).filter(nonEmpty));
	if (terms.length === 0 || regions.length === 0) return new Map();
	const exactTerms = exactQueryTerms(plan);
	const facts = new Map(regions.map((region) => [region.unit.id, collectRegionFacts(region)]));
	const statistics = scopeStatistics([...facts.values()], terms);
	const weights = fieldWeights(plan);
	const scores = new Map<string, LexicalRegionScore>();
	for (const region of regions) {
		const regionFacts = facts.get(region.unit.id);
		if (regionFacts === undefined) continue;
		const matchedTerms = terms.filter((term) => fieldHas(regionFacts.fields, term));
		const expandedCoverage = matchedTerms.length / terms.length;
		const exactMatched = exactTerms.filter((term) => fieldHas(regionFacts.fields, term));
		const exactTokenCoverage = exactTerms.length === 0 ? expandedCoverage : exactMatched.length / exactTerms.length;
		let score = bm25f(regionFacts, matchedTerms, statistics, weights);
		const orderedCoverage = orderedTokenCoverage(regionFacts.sequence, terms);
		const minimumSpan = shortestCoveringSpan(regionFacts.sequence, terms);
		const concentration = lineConcentration(regionFacts.lineSequences, terms);
		const phrase = phraseFeatures(regionFacts, terms);
		const anchor = anchorFeatures(region.anchors, terms);

		score += exactTokenCoverage * 2.4;
		score += expandedCoverage * 1.6;
		score += orderedCoverage * 1.4;
		score += concentration * 1.2;
		if (minimumSpan !== undefined) score += 1.8 / (1 + Math.log1p(Math.max(0, minimumSpan - terms.length)));
		score += phrase.symbol * 4.5 + phrase.signature * 3.2 + phrase.sameLine * 2.2;
		score += anchor.phrase * 1.4 + anchor.identifier * 0.5 + anchor.coverage * 0.8 + anchor.fieldAffinity * 0.6;
		score -= Math.log1p(regionFacts.regionLength) * 0.18;
		const highCoverage = terms.length > 1 && (expandedCoverage >= 0.6 || anchor.coverage >= 0.6);
		scores.set(region.unit.id, {
			quality: Math.round(score * 1_000),
			matchedTerms,
			exactTokenCoverage,
			expandedCoverage,
			highCoverage,
			evidenceLines: lexicalEvidenceLines(region, terms),
		});
	}
	return scores;
}

function lexicalEvidenceLines(region: LexicalScoringRegion, terms: readonly string[]): LexicalEvidenceLine[] {
	return region.content.split(/\r?\n/u)
		.map((text, offset) => {
			const tokens = tokenizeText(text);
			const matchedTerms = terms.filter((term) => tokens.has(term));
			const positions = matchedTerms.flatMap((term) => {
				const index = text.toLocaleLowerCase().indexOf(term);
				return index < 0 ? [] : [index];
			});
			const span = positions.length < 2 ? 0 : Math.max(...positions) - Math.min(...positions);
			return { line: region.unit.startLine + offset, text, matchedTerms, span, length: [...text].length };
		})
		.filter((line) => line.matchedTerms.length > 0)
		.sort((left, right) => right.matchedTerms.length - left.matchedTerms.length
			|| left.span - right.span || left.length - right.length || left.line - right.line)
		.map(({ line, text, matchedTerms }) => ({ line, text, matchedTerms }));
}

function collectRegionFacts(region: LexicalScoringRegion): RegionFacts {
	const body = splitBodyFields(region.content, region.unit.signature);
	const texts: Record<LexicalField, string> = {
		symbol: region.unit.qualifiedName ?? region.unit.name ?? "",
		signature: signatureFieldText(region.unit.signature),
		path: region.unit.path,
		code: body.code,
		comment: body.comment,
		string: body.string,
	};
	const fields: Record<LexicalField, FieldFacts> = {
		symbol: fieldFacts(texts.symbol),
		signature: fieldFacts(texts.signature),
		path: fieldFacts(texts.path),
		code: fieldFacts(texts.code),
		comment: fieldFacts(texts.comment),
		string: fieldFacts(texts.string),
	};
	const lines = region.content.split(/\r?\n/u);
	return {
		fields,
		sequence: tokenizeTextSequence(region.content),
		lineSequences: lines.map(tokenizeTextSequence),
		regionLength: Math.max(1, region.unit.endLine - region.unit.startLine + 1),
	};
}

function scopeStatistics(facts: readonly RegionFacts[], queryTerms: readonly string[]): ScopeStatistics {
	const documentCount = Math.max(1, facts.length);
	const lengthSums: Record<LexicalField, number> = { symbol: 0, signature: 0, path: 0, code: 0, comment: 0, string: 0 };
	const documentFrequency = new Map<string, number>();
	for (const fact of facts) {
		for (const field of lexicalFields()) lengthSums[field] += fact.fields[field].length;
		for (const term of queryTerms) {
			if (fieldHas(fact.fields, term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
		}
	}
	return {
		documentCount,
		averageLengths: mapFields((field) => Math.max(1, lengthSums[field] / documentCount)),
		documentFrequency,
	};
}

function bm25f(
	facts: RegionFacts,
	terms: readonly string[],
	statistics: ScopeStatistics,
	weights: Readonly<Record<LexicalField, WeightedField>>,
): number {
	let result = 0;
	for (const term of terms) {
		let combinedFrequency = 0;
		for (const field of lexicalFields()) {
			const frequency = facts.fields[field].tokens.get(term) ?? 0;
			if (frequency === 0) continue;
			const policy = weights[field];
			const lengthRatio = facts.fields[field].length / statistics.averageLengths[field];
			combinedFrequency += policy.weight * frequency / (1 - policy.b + policy.b * lengthRatio);
		}
		if (combinedFrequency === 0) continue;
		const frequency = statistics.documentFrequency.get(term) ?? 0;
		const idf = Math.log(1 + (statistics.documentCount - frequency + 0.5) / (frequency + 0.5));
		result += idf * (combinedFrequency * (BM25_K1 + 1)) / (combinedFrequency + BM25_K1);
	}
	return result;
}

function fieldWeights(plan: QueryPlan): Readonly<Record<LexicalField, WeightedField>> {
	const naturalLanguage = plan.shape === "natural_language";
	const errorLike = isErrorLikeQuery(plan.query);
	return {
		symbol: { weight: 4.8, b: 0.15 },
		signature: { weight: 3.2, b: 0.3 },
		path: { weight: 1.4, b: 0.25 },
		code: { weight: 1, b: 0.72 },
		comment: { weight: naturalLanguage ? 1.25 : 0.7, b: 0.65 },
		string: { weight: errorLike ? 1.4 : 0.35, b: 0.65 },
	};
}

function phraseFeatures(facts: RegionFacts, terms: readonly string[]): { readonly symbol: number; readonly signature: number; readonly sameLine: number } {
	return {
		symbol: containsTokenPhrase(tokenizeTextSequence(facts.fields.symbol.text), terms) ? 1 : 0,
		signature: containsTokenPhrase(tokenizeTextSequence(facts.fields.signature.text), terms) ? 1 : 0,
		sameLine: facts.lineSequences.some((line) => containsTokenPhrase(line, terms)) ? 1 : 0,
	};
}

function anchorFeatures(
	anchors: readonly LexicalTextAnchor[],
	terms: readonly string[],
): { readonly phrase: number; readonly identifier: number; readonly coverage: number; readonly fieldAffinity: number } {
	let phrase = 0;
	let identifier = 0;
	let coverage = 0;
	let fieldAffinity = 0;
	for (const anchor of anchors) {
		if (anchor.phrase) phrase = 1;
		if (anchor.identifier) identifier = 1;
		const matched = new Set(anchor.matchedTerms.map(normalizeToken));
		coverage = Math.max(coverage, terms.filter((term) => matched.has(term)).length / terms.length);
		if (anchor.commentLike) fieldAffinity = Math.max(fieldAffinity, 1);
		else if (!anchor.stringLike) fieldAffinity = Math.max(fieldAffinity, 0.7);
		else fieldAffinity = Math.max(fieldAffinity, 0.25);
	}
	return { phrase, identifier, coverage, fieldAffinity };
}

function lineConcentration(lines: readonly (readonly string[])[], terms: readonly string[]): number {
	const expected = new Set(terms);
	let hitStart: number | undefined;
	let hitEnd: number | undefined;
	let maximumDistinct = 0;
	let hitLines = 0;
	for (const [index, line] of lines.entries()) {
		const matched = new Set(line.filter((token) => expected.has(token)));
		if (matched.size === 0) continue;
		hitStart ??= index;
		hitEnd = index;
		hitLines += 1;
		maximumDistinct = Math.max(maximumDistinct, matched.size);
	}
	if (hitStart === undefined || hitEnd === undefined) return 0;
	const compactness = hitLines / Math.max(1, hitEnd - hitStart + 1);
	return (maximumDistinct / terms.length + compactness) / 2;
}

function orderedTokenCoverage(sequence: readonly string[], terms: readonly string[]): number {
	if (terms.length === 0) return 0;
	let previous = Array.from({ length: terms.length + 1 }, () => 0);
	for (const token of sequence) {
		const current = [0];
		for (let index = 1; index <= terms.length; index += 1) {
			current[index] = token === terms[index - 1]
				? (previous[index - 1] ?? 0) + 1
				: Math.max(previous[index] ?? 0, current[index - 1] ?? 0);
		}
		previous = current;
	}
	return (previous[terms.length] ?? 0) / terms.length;
}

function shortestCoveringSpan(sequence: readonly string[], terms: readonly string[]): number | undefined {
	const expected = new Set(terms);
	if (expected.size === 0) return undefined;
	const counts = new Map<string, number>();
	let covered = 0;
	let left = 0;
	let minimum: number | undefined;
	for (let right = 0; right < sequence.length; right += 1) {
		const token = sequence[right];
		if (token !== undefined && expected.has(token)) {
			const count = counts.get(token) ?? 0;
			counts.set(token, count + 1);
			if (count === 0) covered += 1;
		}
		while (covered === expected.size && left <= right) {
			minimum = Math.min(minimum ?? Number.POSITIVE_INFINITY, right - left + 1);
			const leftToken = sequence[left];
			left += 1;
			if (leftToken === undefined || !expected.has(leftToken)) continue;
			const count = (counts.get(leftToken) ?? 1) - 1;
			counts.set(leftToken, count);
			if (count === 0) covered -= 1;
		}
	}
	return minimum;
}

function containsTokenPhrase(sequence: readonly string[], terms: readonly string[]): boolean {
	if (terms.length === 0 || sequence.length < terms.length) return false;
	outer: for (let start = 0; start <= sequence.length - terms.length; start += 1) {
		for (let offset = 0; offset < terms.length; offset += 1) {
			if (sequence[start + offset] !== terms[offset]) continue outer;
		}
		return true;
	}
	return false;
}

function splitBodyFields(content: string, signature: string | undefined): { readonly code: string; readonly comment: string; readonly string: string } {
	const code: string[] = [];
	const comment: string[] = [];
	const strings: string[] = [];
	let signatureSkipped = signature === undefined;
	let blockComment = false;
	let docDelimiter: "'''" | "\"\"\"" | undefined;
	for (const rawLine of content.split(/\r?\n/u)) {
		let line = rawLine;
		if (!signatureSkipped && rawLine.trim() === signature) {
			signatureSkipped = true;
			const bodyStart = rawLine.indexOf("{");
			if (bodyStart === -1) continue;
			line = rawLine.slice(bodyStart + 1);
		}
		let index = 0;
		while (index < line.length) {
			if (blockComment) {
				const end = line.indexOf("*/", index);
				if (end === -1) { comment.push(line.slice(index)); break; }
				comment.push(line.slice(index, end + 2));
				index = end + 2;
				blockComment = false;
				continue;
			}
			if (docDelimiter !== undefined) {
				const end = line.indexOf(docDelimiter, index);
				if (end === -1) { comment.push(line.slice(index)); break; }
				comment.push(line.slice(index, end + docDelimiter.length));
				index = end + docDelimiter.length;
				docDelimiter = undefined;
				continue;
			}
			const marker = nextMarker(line, index);
			if (marker === undefined) { code.push(line.slice(index)); break; }
			if (marker.index > index) code.push(line.slice(index, marker.index));
			if (marker.kind === "line-comment") { comment.push(line.slice(marker.index)); break; }
			if (marker.kind === "block-comment") {
				blockComment = true;
				index = marker.index;
				continue;
			}
			if (marker.kind === "docstring") {
				const end = line.indexOf(marker.delimiter, marker.index + marker.delimiter.length);
				if (end === -1) {
					comment.push(line.slice(marker.index));
					docDelimiter = marker.delimiter;
					break;
				}
				comment.push(line.slice(marker.index, end + marker.delimiter.length));
				index = end + marker.delimiter.length;
				continue;
			}
			const end = quotedEnd(line, marker.index, marker.delimiter);
			strings.push(line.slice(marker.index, end));
			index = end;
		}
	}
	return { code: code.join("\n"), comment: comment.join("\n"), string: strings.join("\n") };
}

type Marker =
	| { readonly index: number; readonly kind: "line-comment" }
	| { readonly index: number; readonly kind: "block-comment" }
	| { readonly index: number; readonly kind: "docstring"; readonly delimiter: "'''" | "\"\"\"" }
	| { readonly index: number; readonly kind: "string"; readonly delimiter: "'" | "\"" | "`" };

function nextMarker(line: string, start: number): Marker | undefined {
	const candidates: Marker[] = [];
	for (const [value, kind] of [["//", "line-comment"], ["/*", "block-comment"]] as const) {
		const index = line.indexOf(value, start);
		if (index >= 0) candidates.push({ index, kind });
	}
	const prefix = line.slice(0, start).trim();
	if (prefix.length === 0) {
		for (const value of ["#", "--"] as const) {
			const index = line.indexOf(value, start);
			if (index >= 0 && line.slice(0, index).trim().length === 0) candidates.push({ index, kind: "line-comment" });
		}
	}
	for (const delimiter of ["'''", "\"\"\""] as const) {
		const index = line.indexOf(delimiter, start);
		if (index >= 0) candidates.push({ index, kind: "docstring", delimiter });
	}
	for (const delimiter of ["'", "\"", "`"] as const) {
		const index = line.indexOf(delimiter, start);
		if (index >= 0) candidates.push({ index, kind: "string", delimiter });
	}
	return candidates.sort((left, right) => left.index - right.index || markerPriority(left) - markerPriority(right))[0];
}

function markerPriority(marker: Marker): number {
	if (marker.kind === "docstring") return 0;
	if (marker.kind === "line-comment" || marker.kind === "block-comment") return 1;
	return 2;
}

function quotedEnd(line: string, start: number, delimiter: "'" | "\"" | "`"): number {
	let escaped = false;
	for (let index = start + 1; index < line.length; index += 1) {
		const character = line[index];
		if (escaped) { escaped = false; continue; }
		if (character === "\\") { escaped = true; continue; }
		if (character === delimiter) return index + 1;
	}
	return line.length;
}

function signatureFieldText(signature: string | undefined): string {
	return signature ?? "";
}

function exactQueryTerms(plan: QueryPlan): string[] {
	const source = plan.targetTerms.length > 0 ? plan.targetTerms : [plan.query];
	return unique(source.flatMap((value) => value.match(/[$_\p{L}\p{N}]+/gu) ?? []).map(normalizeToken).filter(nonEmpty));
}

function fieldHas(fields: Readonly<Record<LexicalField, FieldFacts>>, term: string): boolean {
	return lexicalFields().some((field) => fields[field].tokens.has(term));
}

function fieldFacts(text: string): FieldFacts {
	const tokens = tokenizeText(text);
	return { text, tokens, length: tokenCount(tokens) };
}

function tokenCount(tokens: ReadonlyMap<string, number>): number {
	let count = 0;
	for (const frequency of tokens.values()) count += frequency;
	return count;
}

function lexicalFields(): readonly LexicalField[] {
	return ["symbol", "signature", "path", "code", "comment", "string"];
}

function mapFields(value: (field: LexicalField) => number): Readonly<Record<LexicalField, number>> {
	return {
		symbol: value("symbol"),
		signature: value("signature"),
		path: value("path"),
		code: value("code"),
		comment: value("comment"),
		string: value("string"),
	};
}

function normalizeToken(value: string): string {
	return value.toLocaleLowerCase();
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function nonEmpty(value: string): boolean {
	return value.length > 0;
}

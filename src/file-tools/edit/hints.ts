import { findAll } from "./matches.js";
import type {
	EditAnchorCandidate,
	EditMatchHint,
	EditNotFoundRecovery,
	EditReplacement,
} from "./types.js";

const MAX_ANCHORS = 8;
const MAX_ANCHOR_OCCURRENCES = 64;
const CONTEXT_RADIUS = 2;
const COMPARISON_RADIUS = 3;

/** Builds shortest unique retryable replacements for ambiguous matches. */
export function buildEditMatchHints(
	text: string,
	old: string,
	replacement: string,
	starts: readonly number[],
	limit: number,
): EditMatchHint[] {
	return starts.slice(0, limit).map((start) => {
		const context = shortestUniqueContext(text, old, start, starts);
		const relativeStart = start - context.start;
		return {
			line: lineNumber(text, start),
			old: context.text,
			new: `${context.text.slice(0, relativeStart)}${replacement}${context.text.slice(relativeStart + old.length)}`,
		};
	});
}

interface Context { start: number; text: string }

function shortestUniqueContext(text: string, old: string, start: number, starts: readonly number[]): Context {
	const end = start + old.length;
	const left = boundariesBefore(text, start);
	const right = boundariesAfter(text, end);
	const requiredRightCounts = buildRequiredRightCounts(text, old.length, start, starts, left.length);
	let best: { start: number; end: number; length: number; leftCount: number } | undefined;
	for (const leftBoundary of left) {
		const requiredRightCount = requiredRightCounts[leftBoundary.count] ?? 0;
		const rightBoundary = right[requiredRightCount];
		if (rightBoundary === undefined) continue;
		const length = leftBoundary.count + rightBoundary.count;
		if (best === undefined || length < best.length || (length === best.length && leftBoundary.count < best.leftCount)) {
			best = { start: leftBoundary.index, end: rightBoundary.index, length, leftCount: leftBoundary.count };
		}
	}
	if (best !== undefined) {
		const candidate = text.slice(best.start, best.end);
		if (isUniqueOccurrenceAt(text, candidate, best.start)) return { start: best.start, text: candidate };
	}
	const maxLeftCount = left.length - 1;
	const maxRightCount = right.length - 1;
	for (let length = 0; length <= maxLeftCount + maxRightCount; length += 1) {
		const firstLeftCount = Math.max(0, length - maxRightCount);
		const lastLeftCount = Math.min(length, maxLeftCount);
		for (let leftCount = firstLeftCount; leftCount <= lastLeftCount; leftCount += 1) {
			const leftBoundary = left[leftCount];
			const rightBoundary = right[length - leftCount];
			if (leftBoundary === undefined || rightBoundary === undefined) continue;
			const candidate = text.slice(leftBoundary.index, rightBoundary.index);
			if (isUniqueOccurrenceAt(text, candidate, leftBoundary.index)) return { start: leftBoundary.index, text: candidate };
		}
	}
	return { start: 0, text };
}

function buildRequiredRightCounts(
	text: string,
	oldLength: number,
	start: number,
	starts: readonly number[],
	leftBoundaryCount: number,
): Uint32Array {
	const required = new Uint32Array(leftBoundaryCount);
	const end = start + oldLength;
	for (const otherStart of starts) {
		if (otherStart === start) continue;
		const commonLeft = Math.min(commonSuffixCodePoints(text, start, otherStart), leftBoundaryCount - 1);
		const commonRight = commonPrefixCodePoints(text, end, otherStart + oldLength) + 1;
		required[commonLeft] = Math.max(required[commonLeft] ?? 0, commonRight);
	}
	for (let leftCount = required.length - 2; leftCount >= 0; leftCount -= 1) {
		required[leftCount] = Math.max(required[leftCount] ?? 0, required[leftCount + 1] ?? 0);
	}
	return required;
}

function isUniqueOccurrenceAt(text: string, candidate: string, expectedStart: number): boolean {
	const first = text.indexOf(candidate);
	return first === expectedStart && text.indexOf(candidate, first + candidate.length) === -1;
}

function boundariesBefore(text: string, index: number): Array<{ index: number; count: number }> {
	const result = [{ index, count: 0 }];
	let current = index;
	let count = 0;
	while (current > 0) {
		current = previousCodePointIndex(text, current);
		result.push({ index: current, count: ++count });
	}
	return result;
}

function boundariesAfter(text: string, index: number): Array<{ index: number; count: number }> {
	const result = [{ index, count: 0 }];
	let current = index;
	let count = 0;
	while (current < text.length) {
		current = nextCodePointIndex(text, current);
		result.push({ index: current, count: ++count });
	}
	return result;
}

function commonSuffixCodePoints(text: string, firstEnd: number, secondEnd: number): number {
	let first = firstEnd;
	let second = secondEnd;
	let count = 0;
	while (first > 0 && second > 0) {
		const firstStart = previousCodePointIndex(text, first);
		const secondStart = previousCodePointIndex(text, second);
		if (text.slice(firstStart, first) !== text.slice(secondStart, second)) break;
		first = firstStart;
		second = secondStart;
		count += 1;
	}
	return count;
}

function commonPrefixCodePoints(text: string, firstStart: number, secondStart: number): number {
	let first = firstStart;
	let second = secondStart;
	let count = 0;
	while (first < text.length && second < text.length) {
		const firstEnd = nextCodePointIndex(text, first);
		const secondEnd = nextCodePointIndex(text, second);
		if (text.slice(first, firstEnd) !== text.slice(second, secondEnd)) break;
		first = firstEnd;
		second = secondEnd;
		count += 1;
	}
	return count;
}

function previousCodePointIndex(text: string, index: number): number {
	const code = text.charCodeAt(index - 1);
	return code >= 0xdc00 && code <= 0xdfff ? index - 2 : index - 1;
}
function nextCodePointIndex(text: string, index: number): number {
	const code = text.charCodeAt(index);
	return code >= 0xd800 && code <= 0xdbff && index + 1 < text.length ? index + 2 : index + 1;
}
function lineNumber(text: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset; index += 1) {
		if (text[index] === "\r") {
			line += 1;
			if (text[index + 1] === "\n") index += 1;
		} else if (text[index] === "\n") line += 1;
	}
	return line;
}

/** Diagnoses a failed exact match without weakening replacement semantics. */
export function buildEditNotFoundRecovery(
	text: string,
	old: string,
	previous: readonly EditReplacement[],
	limit: number,
): EditNotFoundRecovery {
	const afterEditIndex = findIntroducingEdit(text, old, previous);
	if (afterEditIndex !== undefined) return { kind: "dependent", afterEditIndex };
	const formatCandidate = findUniqueFormatCandidate(text, old);
	if (formatCandidate !== undefined) return { kind: "format", candidate: formatCandidate };
	const candidates = buildAnchorCandidates(text, old, limit);
	return candidates.length === 0 ? { kind: "none" } : { kind: "anchors", candidates };
}

function findIntroducingEdit(text: string, old: string, previous: readonly EditReplacement[]): number | undefined {
	let simulated = text;
	for (let index = 0; index < previous.length; index += 1) {
		const replacement = previous[index];
		if (replacement === undefined) continue;
		const starts = findAll(simulated, replacement.old);
		if (starts.length === 0 || (starts.length > 1 && replacement.replace_all !== true)) return undefined;
		simulated = replaceAtStarts(simulated, replacement.old, replacement.new, starts);
		if (simulated.includes(old)) return index;
	}
	return undefined;
}

function replaceAtStarts(text: string, old: string, replacement: string, starts: readonly number[]): string {
	let output = "";
	let cursor = 0;
	for (const start of starts) {
		output += text.slice(cursor, start) + replacement;
		cursor = start + old.length;
	}
	return output + text.slice(cursor);
}

interface NormalizedSource {
	text: string;
	checkpointOffsets: number[];
	checkpointDeltas: number[];
	specialOffsets: number[];
	specialStarts: number[];
	specialEnds: number[];
}

function findUniqueFormatCandidate(text: string, old: string): { line: number; old: string } | undefined {
	const source = normalizeFormatting(text);
	const normalizedOld = normalizeFormatting(old).text;
	if (normalizedOld.length === 0) return undefined;
	const exactShape = normalizedCandidates(text, source, normalizedOld);
	if (exactShape.length === 1) return exactShape[0];
	if (exactShape.length > 1) return undefined;

	const boundaryCandidates = new Map<string, { line: number; old: string }>();
	for (const variant of boundaryLineVariants(normalizedOld)) {
		for (const candidate of normalizedCandidates(text, source, variant)) {
			boundaryCandidates.set(`${candidate.line}\0${candidate.old}`, candidate);
		}
	}
	return boundaryCandidates.size === 1 ? boundaryCandidates.values().next().value : undefined;
}

function normalizeFormatting(source: string): NormalizedSource {
	const chunks: string[] = [];
	const checkpointOffsets = [0];
	const checkpointDeltas = [0];
	const specialOffsets: number[] = [];
	const specialStarts: number[] = [];
	const specialEnds: number[] = [];
	let normalizedLength = 0;
	let index = 0;
	let atLineStart = true;
	while (index < source.length) {
		const newlineEnd = lineEndingEnd(source, index);
		if (newlineEnd !== undefined) {
			chunks.push("\n");
			if (newlineEnd - index > 1) pushSpecial(specialOffsets, specialStarts, specialEnds, normalizedLength, index, newlineEnd);
			normalizedLength += 1;
			index = newlineEnd;
			pushCheckpoint(checkpointOffsets, checkpointDeltas, normalizedLength, index - normalizedLength);
			atLineStart = true;
			continue;
		}
		if (isHorizontalWhitespace(source[index])) {
			const start = index;
			while (index < source.length && isHorizontalWhitespace(source[index])) index += 1;
			if (atLineStart || index === source.length || lineEndingEnd(source, index) !== undefined) {
				pushCheckpoint(checkpointOffsets, checkpointDeltas, normalizedLength, index - normalizedLength);
				continue;
			}
			chunks.push(" ");
			if (index - start > 1) pushSpecial(specialOffsets, specialStarts, specialEnds, normalizedLength, start, index);
			normalizedLength += 1;
			pushCheckpoint(checkpointOffsets, checkpointDeltas, normalizedLength, index - normalizedLength);
			continue;
		}
		const start = index;
		while (index < source.length && lineEndingEnd(source, index) === undefined && !isHorizontalWhitespace(source[index])) index += 1;
		const chunk = source.slice(start, index);
		chunks.push(chunk);
		normalizedLength += chunk.length;
		atLineStart = false;
	}
	return { text: chunks.join(""), checkpointOffsets, checkpointDeltas, specialOffsets, specialStarts, specialEnds };
}

function pushCheckpoint(offsets: number[], deltas: number[], offset: number, delta: number): void {
	if (offsets[offsets.length - 1] === offset) {
		deltas[deltas.length - 1] = delta;
		return;
	}
	offsets.push(offset);
	deltas.push(delta);
}

function pushSpecial(offsets: number[], starts: number[], ends: number[], offset: number, start: number, end: number): void {
	offsets.push(offset);
	starts.push(start);
	ends.push(end);
}

function lineEndingEnd(text: string, index: number): number | undefined {
	if (text[index] === "\n") return index + 1;
	if (text[index] !== "\r") return undefined;
	return text[index + 1] === "\n" ? index + 2 : index + 1;
}

function isHorizontalWhitespace(value: string | undefined): boolean {
	return value !== undefined && value !== "\r" && value !== "\n" && /\s/u.test(value);
}

function normalizedCandidates(
	original: string,
	normalized: NormalizedSource,
	needle: string,
): Array<{ line: number; old: string }> {
	if (needle.length === 0) return [];
	const candidates: Array<{ line: number; old: string }> = [];
	for (const start of findAll(normalized.text, needle)) {
		const sourceStart = sourceStartAt(normalized, start);
		const sourceEnd = sourceEndAt(normalized, start + needle.length);
		candidates.push({ line: lineNumber(original, sourceStart), old: original.slice(sourceStart, sourceEnd) });
	}
	return candidates;
}

function sourceStartAt(normalized: NormalizedSource, offset: number): number {
	const special = exactIndex(normalized.specialOffsets, offset);
	if (special !== -1) return normalized.specialStarts[special] ?? offset;
	return offset + deltaAt(normalized, offset);
}

function sourceEndAt(normalized: NormalizedSource, offset: number): number {
	const special = exactIndex(normalized.specialOffsets, offset - 1);
	if (special !== -1) return normalized.specialEnds[special] ?? offset;
	return offset + deltaAt(normalized, offset);
}

function deltaAt(normalized: NormalizedSource, offset: number): number {
	let low = 0;
	let high = normalized.checkpointOffsets.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		const checkpoint = normalized.checkpointOffsets[middle];
		if (checkpoint !== undefined && checkpoint <= offset) low = middle;
		else high = middle - 1;
	}
	return normalized.checkpointDeltas[low] ?? 0;
}

function exactIndex(values: readonly number[], target: number): number {
	let low = 0;
	let high = values.length - 1;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const value = values[middle];
		if (value === target) return middle;
		if (value !== undefined && value < target) low = middle + 1;
		else high = middle - 1;
	}
	return -1;
}

function boundaryLineVariants(text: string): string[] {
	const variants = new Set<string>();
	const firstBreak = text.indexOf("\n");
	if (firstBreak !== -1 && firstBreak + 1 < text.length) variants.add(text.slice(firstBreak + 1));
	const withoutFinalBreak = text.endsWith("\n") ? text.slice(0, -1) : text;
	const lastBreak = withoutFinalBreak.lastIndexOf("\n");
	if (lastBreak !== -1) variants.add(withoutFinalBreak.slice(0, lastBreak + (text.endsWith("\n") ? 1 : 0)));
	return [...variants].filter((variant) => variant.length > 0);
}

interface SourceLine {
	start: number;
	end: number;
	text: string;
	normalized: string;
}

interface Anchor {
	kind: "line" | "string" | "identifier";
	value: string;
	oldLine: number;
	count: number;
}

interface RankedAnchorCandidate extends EditAnchorCandidate {
	score: number;
	start: number;
	end: number;
}

function buildAnchorCandidates(text: string, old: string, limit: number): EditAnchorCandidate[] {
	if (limit <= 0) return [];
	const fileLines = splitLines(text);
	const oldLines = splitLines(old);
	if (fileLines.length === 0 || oldLines.length === 0) return [];
	const anchors = collectAnchors(text, fileLines, oldLines).slice(0, MAX_ANCHORS);
	const ranked = new Map<string, RankedAnchorCandidate>();
	for (const anchor of anchors) {
		let occurrences = 0;
		for (let fileLine = 0; fileLine < fileLines.length && occurrences < MAX_ANCHOR_OCCURRENCES; fileLine += 1) {
			const candidateLine = fileLines[fileLine];
			if (candidateLine === undefined || !lineHasAnchor(candidateLine, anchor)) continue;
			occurrences += 1;
			const snippetStartLine = Math.max(0, fileLine - CONTEXT_RADIUS);
			const snippetEndLine = Math.min(fileLines.length - 1, fileLine + CONTEXT_RADIUS);
			const first = fileLines[snippetStartLine];
			const last = fileLines[snippetEndLine];
			if (first === undefined || last === undefined) continue;
			const key = `${first.start}:${last.end}`;
			const candidate: RankedAnchorCandidate = {
				line: snippetStartLine + 1,
				text: text.slice(first.start, last.end),
				score: anchorScore(anchor) + neighborhoodScore(oldLines, fileLines, anchor.oldLine, fileLine),
				start: first.start,
				end: last.end,
			};
			const current = ranked.get(key);
			if (current === undefined || candidate.score > current.score) ranked.set(key, candidate);
		}
	}
	return [...ranked.values()]
		.sort((left, right) => right.score - left.score || left.start - right.start || left.end - right.end)
		.slice(0, limit)
		.map(({ line, text: candidateText }) => ({ line, text: candidateText }));
}

function collectAnchors(text: string, fileLines: readonly SourceLine[], oldLines: readonly SourceLine[]): Anchor[] {
	const candidates: Array<Omit<Anchor, "count">> = [];
	const longestLines = oldLines
		.map((line, index) => ({ value: line.normalized, oldLine: index }))
		.filter((line) => line.value.length > 0)
		.sort((left, right) => right.value.length - left.value.length)
		.slice(0, MAX_ANCHORS);
	for (const line of longestLines) candidates.push({ kind: "line", value: line.value, oldLine: line.oldLine });

	for (let oldLine = 0; oldLine < oldLines.length; oldLine += 1) {
		const line = oldLines[oldLine];
		if (line === undefined) continue;
		for (const value of line.text.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gu) ?? []) {
			if (value.length >= 3) candidates.push({ kind: "string", value, oldLine });
		}
		for (const value of line.text.match(/[A-Za-z_$][A-Za-z0-9_$]*/gu) ?? []) {
			if (value.length >= 3) candidates.push({ kind: "identifier", value, oldLine });
		}
	}

	const unique = new Map<string, Omit<Anchor, "count">>();
	for (const candidate of candidates) unique.set(`${candidate.kind}\0${candidate.value}\0${candidate.oldLine}`, candidate);
	return [...unique.values()]
		.map((candidate): Anchor => ({
			...candidate,
			count: candidate.kind === "line"
				? fileLines.reduce((count, line) => count + (line.normalized === candidate.value ? 1 : 0), 0)
				: findAll(text, candidate.value).length,
		}))
		.filter((anchor) => anchor.count > 0)
		.sort((left, right) => left.count - right.count
			|| anchorKindRank(right.kind) - anchorKindRank(left.kind)
			|| right.value.length - left.value.length);
}

function splitLines(text: string): SourceLine[] {
	const lines: SourceLine[] = [];
	let start = 0;
	let index = 0;
	while (index < text.length) {
		const newlineEnd = lineEndingEnd(text, index);
		if (newlineEnd === undefined) {
			index += 1;
			continue;
		}
		const value = text.slice(start, index);
		lines.push({ start, end: newlineEnd, text: value, normalized: normalizeFormatting(value).text });
		start = newlineEnd;
		index = newlineEnd;
	}
	if (start < text.length || text.length === 0) {
		const value = text.slice(start);
		lines.push({ start, end: text.length, text: value, normalized: normalizeFormatting(value).text });
	}
	return lines;
}

function lineHasAnchor(line: SourceLine, anchor: Anchor): boolean {
	return anchor.kind === "line" ? line.normalized === anchor.value : line.text.includes(anchor.value);
}

function anchorScore(anchor: Anchor): number {
	return 1000 / anchor.count + anchorKindRank(anchor.kind) * 20 + Math.min(anchor.value.length, 100);
}

function anchorKindRank(kind: Anchor["kind"]): number {
	switch (kind) {
		case "string": return 3;
		case "line": return 2;
		case "identifier": return 1;
	}
}

function neighborhoodScore(
	oldLines: readonly SourceLine[],
	fileLines: readonly SourceLine[],
	oldAnchorLine: number,
	fileAnchorLine: number,
): number {
	let score = 0;
	for (let delta = -COMPARISON_RADIUS; delta <= COMPARISON_RADIUS; delta += 1) {
		const oldLine = oldLines[oldAnchorLine + delta];
		const fileLine = fileLines[fileAnchorLine + delta];
		if (oldLine === undefined || fileLine === undefined) continue;
		score += lineSimilarity(oldLine.normalized, fileLine.normalized);
	}
	return score;
}

function lineSimilarity(left: string, right: string): number {
	if (left === right) return left.length === 0 ? 2 : 20;
	const leftTokens = new Set(left.match(/[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/gu) ?? []);
	const rightTokens = new Set(right.match(/[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/gu) ?? []);
	if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
	let shared = 0;
	for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
	return Math.round((shared * 10) / Math.max(leftTokens.size, rightTokens.size));
}

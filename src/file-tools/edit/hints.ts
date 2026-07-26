import type { EditMatchHint } from "./types.js";

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
	const otherStarts = starts.filter((candidate) => candidate !== start);
	let best: { start: number; end: number; length: number; leftCount: number } | undefined;
	for (const leftBoundary of left) {
		const leftCount = leftBoundary.count;
		let requiredRightCount = 0;
		for (const otherStart of otherStarts) {
			const otherEnd = otherStart + old.length;
			if (leftCount <= commonSuffixCodePoints(text, start, otherStart)) {
				requiredRightCount = Math.max(requiredRightCount, commonPrefixCodePoints(text, end, otherEnd) + 1);
			}
		}
		const rightBoundary = right.find((candidate) => candidate.count >= requiredRightCount);
		if (rightBoundary === undefined) continue;
		const length = leftCount + rightBoundary.count;
		if (best === undefined || length < best.length || (length === best.length && leftCount < best.leftCount)) {
			best = { start: leftBoundary.index, end: rightBoundary.index, length, leftCount };
		}
	}
	if (best !== undefined) {
		const candidate = text.slice(best.start, best.end);
		if (findAll(text, candidate).length === 1) return { start: best.start, text: candidate };
	}
	for (let length = 0; length <= left.length + right.length; length += 1) {
		for (const leftBoundary of left) {
			const rightCount = length - leftBoundary.count;
			if (rightCount < 0) continue;
			const rightBoundary = right.find((candidate) => candidate.count === rightCount);
			if (rightBoundary === undefined) continue;
			const candidate = text.slice(leftBoundary.index, rightBoundary.index);
			if (findAll(text, candidate).length === 1) return { start: leftBoundary.index, text: candidate };
		}
	}
	return { start: 0, text };
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
function findAll(text: string, needle: string): number[] {
	const starts: number[] = [];
	let cursor = 0;
	while (cursor <= text.length - needle.length) {
		const found = text.indexOf(needle, cursor);
		if (found === -1) break;
		starts.push(found);
		cursor = found + Math.max(needle.length, 1);
	}
	return starts;
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

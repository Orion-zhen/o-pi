import type { WebFetchRange, WebFetchTextSpan } from "../core/types.js";

const MAX_PASSAGE_CHARS = 800;
const CONTEXT_CHARS = 160;

export interface TextSelection {
	text: string;
	range: WebFetchRange;
}

export function selectText(text: string, offset: number, limit: number, find?: { text: string; maxPassages: number }): TextSelection {
	const start = startBoundary(text, Math.min(text.length, offset));
	if (find !== undefined) return findText(text, find.text, start, limit, find.maxPassages);
	let end = startBoundary(text, Math.min(text.length, start + limit));
	if (end < text.length) {
		const newline = text.lastIndexOf("\n", end);
		if (newline > start && end - newline < 1000) end = newline + 1;
		end = startBoundary(text, end);
	}
	return {
		text: text.slice(start, end),
		range: { kind: "read", start, end, total: text.length, has_more: end < text.length, ...(end < text.length ? { next_offset: end } : {}) },
	};
}

/** 匹配只决定坐标，原文不折叠大小写、不改写、不拼接成虚假的连续范围。 */
function findText(text: string, find: string, start: number, limit: number, maxPassages: number): TextSelection {
	const pattern = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu");
	pattern.lastIndex = start;
	const maxPassageChars = Math.max(MAX_PASSAGE_CHARS, find.length);
	const passages: WebFetchTextSpan[] = [];
	const blocks = textBlocks(text);
	let block = blocks.next().value;
	let remaining = limit;
	let matches = 0;
	let nextOffset: number | undefined;
	for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
		const hit = { start: match.index, end: match.index + match[0].length };
		const previous = passages.at(-1);
		if (previous !== undefined && hit.end <= previous.end) {
			matches += 1;
			continue;
		}
		while (block !== undefined && block.end <= hit.start) block = blocks.next().value;
		if (previous !== undefined && hit.start <= previous.end + CONTEXT_CHARS) {
			const bound = Math.min(text.length, previous.start + maxPassageChars, previous.end + remaining);
			if (hit.end <= bound) {
				const end = contextEnd(text, hit.end, bound, block);
				remaining -= end - previous.end;
				previous.end = end;
				matches += 1;
				continue;
			}
		}
		if (passages.length === maxPassages || remaining < hit.end - hit.start) {
			nextOffset = hit.start;
			break;
		}
		const passage = contextRange(text, hit, Math.max(start, previous?.end ?? start), Math.min(remaining, maxPassageChars), block);
		passages.push(passage);
		remaining -= passage.end - passage.start;
		matches += 1;
	}
	return {
		text: passages.map((passage) => `[${passage.start}-${passage.end}]\n${text.slice(passage.start, passage.end)}`).join("\n\n"),
		range: { kind: "find", start, total: text.length, matches, passages, has_more: nextOffset !== undefined, ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}) },
	};
}

function contextRange(text: string, hit: WebFetchTextSpan, lower: number, budget: number, block: WebFetchTextSpan | undefined): WebFetchTextSpan {
	if (block !== undefined && block.start >= lower && block.end >= hit.end && block.end - block.start <= budget) return { ...block };
	const before = Math.min(CONTEXT_CHARS, Math.floor((budget - (hit.end - hit.start)) / 2));
	const start = startBoundary(text, Math.max(lower, hit.start - before));
	return { start, end: contextEnd(text, hit.end, Math.min(text.length, start + budget), block) };
}

function contextEnd(text: string, hitEnd: number, bound: number, block: WebFetchTextSpan | undefined): number {
	if (block !== undefined && block.end >= hitEnd && block.end <= bound) return block.end;
	return endBoundary(text, Math.min(bound, hitEnd + CONTEXT_CHARS));
}

/** 顺序识别段落和围栏代码块，只保留当前位置，不为页面建立索引。 */
function* textBlocks(text: string): Generator<WebFetchTextSpan, undefined> {
	let start = 0;
	let end = 0;
	let fence: { marker: string; length: number } | undefined;
	for (let lineStart = 0; lineStart < text.length;) {
		const newline = text.indexOf("\n", lineStart);
		const lineEnd = newline < 0 ? text.length : newline;
		const line = text.slice(lineStart, lineEnd);
		const next = lineEnd + 1;
		const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
		const marker = delimiter?.[1];
		if (fence !== undefined) {
			end = lineEnd;
			if (marker?.startsWith(fence.marker) && marker.length >= fence.length && delimiter?.[2]?.trim() === "") {
				yield { start, end };
				fence = undefined;
				start = next;
			}
		} else if (marker !== undefined) {
			if (end > start) yield { start, end };
			start = lineStart;
			end = lineEnd;
			fence = { marker: marker.charAt(0), length: marker.length };
		} else if (/^[\t ]*$/u.test(line)) {
			if (end > start) yield { start, end };
			start = next;
		} else {
			end = lineEnd;
		}
		lineStart = next;
	}
	if (end > start) yield { start, end };
}

function startBoundary(text: string, index: number): number {
	const code = text.charCodeAt(index);
	return code >= 0xdc00 && code <= 0xdfff ? index + 1 : index;
}

function endBoundary(text: string, index: number): number {
	const code = text.charCodeAt(index);
	return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}

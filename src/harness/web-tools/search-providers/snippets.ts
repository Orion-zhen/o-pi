import { normalizeSearchText, SEARCH_RESULT_MAX_SNIPPET_CHARS } from "../network/url-utils.ts";
import type { CompiledSearchQuery } from "./types.ts";

const CONTEXT_CHARS = 72;
const MAX_MATCHES_PER_TERM = 32;
const ELLIPSIS = "...";

/** 只选一个连续原文窗口，避免拼接不同摘要制造上下文。 */
export function selectSearchSnippet(candidates: readonly string[], query: CompiledSearchQuery): string | undefined {
	const terms = queryTerms(query);
	const texts = new Set(candidates.map(normalizeSearchText).filter(Boolean));
	let best: { text: string; score: number } | undefined;
	for (const text of texts) {
		const starts = new Set([0]);
		for (const { pattern } of terms) {
			let count = 0;
			for (const match of text.matchAll(new RegExp(pattern, "giu"))) {
				starts.add(Math.max(0, match.index - CONTEXT_CHARS));
				if (++count >= MAX_MATCHES_PER_TERM) break;
			}
		}
		for (const start of starts) {
			const excerpt = window(text, start);
			let score = 0;
			for (const { pattern, weight } of terms) if (pattern.test(excerpt)) score += weight;
			// 同分保留提供方原始顺序，不用重复词频或摘要长度代替相关性。
			if (best === undefined || score > best.score) best = { text: excerpt, score };
		}
	}
	return best?.text;
}

function queryTerms(query: CompiledSearchQuery): Array<{ pattern: RegExp; weight: number }> {
	const terms = new Map(query.keyTerms.map((term) => [term, /\d|(?:error|exception)$/iu.test(term) ? 4 : 1]));
	for (const match of query.semanticQuery.matchAll(/"([^"]+)"/gu)) {
		const phrase = match[1]?.trim().toLowerCase();
		if (phrase) terms.set(phrase, 8);
	}
	return [...terms].map(([term, weight]) => {
		const literal = term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		const start = /^[a-z\d_]/iu.test(term) ? "(?<![a-z\\d_])" : "";
		const end = /[a-z\d_]$/iu.test(term) ? "(?![a-z\\d_]|\\.\\d)" : "";
		return { pattern: new RegExp(`${start}${literal}${end}`, "iu"), weight };
	});
}

function window(text: string, offset: number): string {
	let start = safeBoundary(text, offset);
	// 拉到附近词边界，中文等无空格文本仍按字符窗口读取。
	const space = text.indexOf(" ", start);
	if (start > 0 && space >= start && space - start < 24) start = space + 1;
	const prefix = start > 0 ? ELLIPSIS : "";
	const budget = SEARCH_RESULT_MAX_SNIPPET_CHARS - prefix.length;
	let end = Math.min(text.length, start + budget);
	const clipped = end < text.length;
	if (clipped) {
		end = safeBoundary(text, end - ELLIPSIS.length);
		const lastSpace = text.lastIndexOf(" ", end);
		if (lastSpace > start && end - lastSpace < 24) end = lastSpace;
	}
	return `${prefix}${text.slice(start, end).trim()}${clipped ? ELLIPSIS : ""}`;
}

function safeBoundary(text: string, index: number): number {
	const code = text.charCodeAt(index);
	return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}

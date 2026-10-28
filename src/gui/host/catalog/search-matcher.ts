import type { SearchExcerpt } from "../../shared/session-search.ts";

// 统一 sigma 的词尾形式，让分块位置不影响 Unicode 小写匹配。
const fold = (text: string) => text.toLowerCase().replace(/ς/g, "σ");
function lastPoints(text: string, count: number): string {
	const tail = text.slice(-2 * count);
	return /[\ud800-\udfff]/.test(tail) ? Array.from(tail).slice(-count).join("") : tail.slice(-count);
}

export function compileSearch(text: string): readonly string[] {
	const terms = [...new Set(text.trim().split(/\s+/u).filter(Boolean).map(fold))];
	if (!terms.length) throw new Error("请输入搜索关键词。");
	return terms;
}

/** 仅在小写转换改变长度时，将命中区间映射回原文。 */
function originalRange(text: string, start: number, end: number): [number, number] {
	let sourceStart = 0, sourceEnd = 0, normalized = 0;
	for (const point of text) {
		if (normalized <= start) sourceStart = sourceEnd;
		sourceEnd += point.length;
		normalized += fold(point).length;
		if (normalized >= end) break;
	}
	return [sourceStart, sourceEnd];
}

interface Excerpt extends SearchExcerpt { start: number; remaining: number; clipped: boolean }

/** 每块文本只保留匹配所需的尾部和首个命中附近的原文。 */
export class SearchMatcher {
	readonly found: boolean[];
	private contextLength: number;
	private pending = "";
	private offset = 0;
	private tail = "";
	private excerpt: Excerpt | undefined;

	constructor(private terms: readonly string[]) {
		this.found = terms.map(() => false);
		this.contextLength = Math.max(...terms.map((term) => Array.from(term).length)) + 48;
	}

	write(chunk: string): void {
		const text = this.pending + chunk;
		const last = text.charCodeAt(text.length - 1);
		this.pending = last >= 0xd800 && last <= 0xdbff ? text.slice(-1) : "";
		this.scan(this.pending ? text.slice(0, -1) : text);
	}

	finish(): SearchExcerpt | undefined {
		this.scan(this.pending); this.pending = "";
		const excerpt = this.excerpt;
		if (!excerpt) return undefined;
		const prefix = excerpt.start ? "…" : "";
		const [first, ...rest] = excerpt.ranges.sort((a, b) => a[0] - b[0]);
		let last: [number, number] = [first[0] + prefix.length, first[1] + prefix.length];
		const ranges: SearchExcerpt["ranges"] = [last];
		for (const [start, end] of rest) {
			if (start + prefix.length <= last[1]) last[1] = Math.max(last[1], end + prefix.length);
			else { last = [start + prefix.length, end + prefix.length]; ranges.push(last); }
		}
		return { text: prefix + excerpt.text + (excerpt.clipped ? "…" : ""), ranges };
	}

	private scan(chunk: string): void {
		if (!chunk || this.excerpt?.clipped && this.found.every(Boolean)) return;
		const text = this.tail + chunk;
		const base = this.offset - this.tail.length;
		const lower = fold(text);
		const matches: [number, number][] = [];
		for (const [index, term] of this.terms.entries()) {
			if (this.found[index]) continue;
			const start = lower.indexOf(term);
			if (start < 0) continue;
			this.found[index] = true;
			matches.push(lower.length === text.length ? [start, start + term.length] : originalRange(text, start, start + term.length));
		}
		matches.sort((a, b) => a[1] - b[1]);
		const first = matches[0];
		let after = chunk;
		if (!this.excerpt && first) {
			const before = lastPoints(text.slice(0, first[1]), this.contextLength);
			const start = first[1] - before.length;
			this.excerpt = { start: base + start, text: before, ranges: [[first[0] - start, first[1] - start]], remaining: 64, clipped: false };
			matches.shift();
			after = text.slice(first[1]);
		}
		const excerpt = this.excerpt;
		if (excerpt) {
			const points = Array.from(after);
			excerpt.text += points.slice(0, excerpt.remaining).join("");
			excerpt.clipped ||= points.length > excerpt.remaining;
			excerpt.remaining = Math.max(0, excerpt.remaining - points.length);
			for (const [start, end] of matches) {
				const from = base + start - excerpt.start, to = base + end - excerpt.start;
				if (from >= 0 && to <= excerpt.text.length) excerpt.ranges.push([from, to]);
			}
		}
		this.offset += chunk.length;
		this.tail = lastPoints(text, this.contextLength);
	}
}

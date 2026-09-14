import { stripTerminalSequences } from "../../terminal-text.js";
import { eastAsianWidth } from "get-east-asian-width";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 计算纯文本 presentation 的显示列宽，不加载 Pi TUI。 */
export function visibleTextWidth(value: string): number {
	const text = stripTerminalSequences(value).replaceAll("\t", "   ");
	let width = 0;
	for (const { segment } of graphemeSegmenter.segment(text)) {
		width += graphemeWidth(segment);
	}
	return width;
}

/** 保留 ANSI token 的最小单词换行器；供文本与 TUI adapter 共享。 */
export function wrapPresentationText(value: string, width: number): string[] {
	const maxWidth = Math.max(1, width);
	return value.split(/\r\n|\r|\n/u).flatMap((line) => wrapLine(line, maxWidth));
}

function wrapLine(value: string, width: number): string[] {
	if (value.length === 0) return [""];
	if (visibleTextWidth(value) <= width) return [value];
	const tokens = value.split(/(\s+)/u);
	const lines: string[] = [];
	let current = "";
	for (const token of tokens) {
		if (token.length === 0) continue;
		const candidate = current + token;
		if (current.length > 0 && visibleTextWidth(candidate) > width) {
			lines.push(current.trimEnd());
			current = token.trimStart();
		} else {
			current = candidate;
		}
		while (visibleTextWidth(current) > width) {
			const [head, tail] = splitVisible(current, width);
			lines.push(head);
			current = tail;
		}
	}
	if (current.length > 0) lines.push(current.trimEnd());
	return lines.length > 0 ? lines : [""];
}

function splitVisible(value: string, width: number): [string, string] {
	let used = 0;
	let offset = 0;
	for (const { segment, index } of graphemeSegmenter.segment(value)) {
		const next = used + visibleTextWidth(segment);
		if (next > width && offset > 0) break;
		used = next;
		offset = index + segment.length;
		if (used >= width) break;
	}
	const safeOffset = Math.max(1, offset);
	return [value.slice(0, safeOffset), value.slice(safeOffset)];
}

function graphemeWidth(segment: string): number {
	const codePoint = segment.codePointAt(0);
	if (codePoint === undefined) return 0;
	if (/\p{Mark}/u.test(segment[0] ?? "")) return 0;
	if (/\p{Extended_Pictographic}/u.test(segment)) return 2;
	return eastAsianWidth(codePoint, { ambiguousAsWide: false });
}

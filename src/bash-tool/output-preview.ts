import type { BashOutputFormat } from "./types.js";
import { takeHeadBytes, takeTailBytes } from "./utf8.js";

const ERROR_ANCHORS = /\b(error|fatal|failed|failure|panic|exception|traceback|assertion)\b/i;

export function renderOutputPreview(text: string, format: BashOutputFormat, budget: number, failed: boolean): string {
	if (Buffer.byteLength(text) <= budget) return text;
	const label = format === "text" ? "" : structuredLabel(format);
	return label + fitFragment(text, format, budget - Buffer.byteLength(label), failed);
}

/** 头尾分别选择内容，不能让清理或诊断窗口跨越原始输出的缺口。 */
export function renderSplitPreview(
	head: string,
	tail: string,
	omittedBytes: number,
	format: BashOutputFormat,
	budget: number,
	failed: boolean,
): string {
	const label = format === "text" ? "" : structuredLabel(format);
	const gap = `\n[... ${omittedBytes} raw bytes outside preview ...]\n`;
	const available = budget - Buffer.byteLength(label + gap);
	const ratio = format !== "text" ? 0.25 : failed ? 0.5 : 0.2;
	let headBudget = Math.min(Buffer.byteLength(head), Math.floor(available * ratio));
	const tailBudget = Math.min(Buffer.byteLength(tail), available - headBudget);
	headBudget = available - tailBudget;
	return label + fitFragment(head, format, headBudget, failed) + gap + fitFragment(tail, format, tailBudget, failed);
}

export function countLogicalLines(text: string): number {
	if (text.length === 0) return 0;
	const breaks = (text.match(/\n/g) ?? []).length;
	return breaks + (text.endsWith("\n") ? 0 : 1);
}

function fitFragment(text: string, format: BashOutputFormat, budget: number, failed: boolean): string {
	if (Buffer.byteLength(text) <= budget) return text;
	if (format !== "text") return headTailPreview(text, budget, 0.25, "bytes");
	return failed ? failurePreview(text, budget) : headTailPreview(text, budget, 0.2, "lines");
}

function structuredLabel(format: BashOutputFormat): string {
	const label = format === "binary" ? "binary/text preview" : `${format} preview; this is not a complete ${format.toUpperCase()} document`;
	return `[${label}]\n\n`;
}

function headTailPreview(text: string, budget: number, headRatio: number, unit: "lines" | "bytes"): string {
	const total = unit === "lines" ? countLogicalLines(text) : Buffer.byteLength(text);
	const marker = `\n[... ${total} ${unit} omitted ...]\n`;
	const available = budget - Buffer.byteLength(marker);
	const headBudget = Math.floor(available * headRatio);
	const head = takeHeadBytes(text, headBudget).replace(/\n*$/, "");
	const tail = takeTailBytes(text, available - headBudget).replace(/^\n*/, "");
	const returned = unit === "lines" ? countLogicalLines(head) + countLogicalLines(tail) : Buffer.byteLength(head + tail);
	return `${head}\n[... ${Math.max(0, total - returned)} ${unit} omitted ...]\n${tail}`;
}

/** 错误行与上下文优先，剩余预算展示首尾，最后只渲染一次。 */
function failurePreview(text: string, budget: number): string {
	const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
	const anchors = lines.flatMap((line, index) => ERROR_ANCHORS.test(line) ? [index] : []);
	const first = anchors.shift();
	if (first === undefined) return headTailPreview(text, budget, 0.15, "lines");
	const last = anchors.pop();
	const priority = [first, ...(last === undefined ? [] : [last]), ...anchors];
	const sizes = lines.map((line) => Buffer.byteLength(line) + 1);
	const selected = new Set<number>();
	const markerSize = Buffer.byteLength(omissionMarker(lines.length)) + 1;
	let used = 0;
	let ranges = 0;

	const select = (index: number): boolean => {
		if (selected.has(index)) return true;
		const size = sizes[index];
		if (size === undefined) return false;
		const nextRanges = ranges + 1 - Number(selected.has(index - 1)) - Number(selected.has(index + 1));
		// 每个区间前后最多形成 ranges + 1 个缺口，预留最大位数的省略标记。
		if (used + size + markerSize * (nextRanges + 1) > budget) return false;
		selected.add(index);
		used += size;
		ranges = nextRanges;
		return true;
	};
	for (const index of priority) select(index);
	for (const index of priority) {
		if (!selected.has(index)) continue;
		for (const offset of [-1, 1, -2, 2, 3]) select(index + offset);
	}
	for (const [start, step, allowance] of [[0, 1, 0.15], [lines.length - 1, -1, 0.2]] as const) {
		let remaining = Math.floor(budget * allowance);
		for (let index = start; index >= 0 && index < lines.length; index += step) {
			const size = sizes[index];
			if (size === undefined || size > remaining || !select(index)) break;
			remaining -= size;
		}
	}
	// 单个诊断行也可能大于整个预算，此时仍返回有界的头尾预览。
	if (selected.size === 0) return headTailPreview(text, budget, 0.15, "lines");

	const parts: string[] = [];
	let previous = -1;
	for (const [index, line] of lines.entries()) {
		if (!selected.has(index)) continue;
		if (index > previous + 1) parts.push(omissionMarker(index - previous - 1));
		parts.push(line);
		previous = index;
	}
	if (previous < lines.length - 1) parts.push(omissionMarker(lines.length - previous - 1));
	return parts.join("\n");
}

function omissionMarker(lines: number): string {
	return `[... ${lines} lines omitted ...]`;
}

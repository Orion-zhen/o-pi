import { stripVTControlCharacters } from "node:util";

import { takeHeadBytes, takeTailBytes } from "./output-capture.js";
import type { BashLimits, BashOutputFormat, BashOutputState, BashRunStatus, BashToolDetails } from "./types.js";

interface OutputViewInput {
	text: string;
	status: BashRunStatus;
	exitCode?: number;
	durationMs: number;
	totalBytes: number;
	totalLines: number;
	fullOutputPath: string;
	captureComplete: boolean;
	binary: boolean;
	limits: BashLimits;
}

export interface OutputView {
	content: string;
	details: BashToolDetails;
	keepLog: boolean;
}

const ERROR_ANCHORS = /\b(error|fatal|failed|failure|panic|exception|traceback|assertion)\b/i;

/** 生成模型可见的有界、可恢复输出视图；不会修改原始日志。 */
export function createBashOutputView(input: OutputViewInput): OutputView {
	const failed = input.status !== "exited" || input.exitCode !== 0;
	const budget = failed ? input.limits.failure_output_bytes : input.limits.success_output_bytes;
	const detectedFormat = input.binary ? "binary" : detectOutputFormat(input.text);
	const cleaned = cleanForModel(input.text, detectedFormat);
	const sourceComplete = input.captureComplete && input.totalBytes <= Buffer.byteLength(input.text, "utf8");
	const sourceText = cleaned.text;

	let body: string;
	let outputState: BashOutputState = input.captureComplete ? "complete" : "capture_truncated";
	if (detectedFormat !== "text" && Buffer.byteLength(sourceText, "utf8") > budget) {
		body = structuredPreview(sourceText, detectedFormat, budget);
		outputState = input.captureComplete ? "truncated" : "capture_truncated";
	} else if (!sourceComplete && Buffer.byteLength(sourceText, "utf8") <= budget) {
		body = sourceText;
		outputState = input.captureComplete ? "truncated" : "capture_truncated";
	} else if (!sourceComplete || Buffer.byteLength(sourceText, "utf8") > budget) {
		body = failed && detectedFormat === "text" ? failurePreview(sourceText, budget) : headTailPreview(sourceText, budget, 0.2);
		outputState = input.captureComplete ? "truncated" : "capture_truncated";
	} else {
		body = sourceText;
		if (cleaned.compacted) outputState = "compacted";
	}

	body = ensureByteLimit(body, budget);
	const returnedBytes = Buffer.byteLength(body, "utf8");
	const returnedLines = countLogicalLines(body);
	const keepLog = outputState !== "complete" || failed;
	const details: BashToolDetails = {
		status: input.status,
		...(input.exitCode !== undefined ? { exit_code: input.exitCode } : {}),
		duration_ms: input.durationMs,
		output_state: outputState,
		output_format: detectedFormat,
		total_lines: input.totalLines,
		returned_lines: returnedLines,
		total_bytes: input.totalBytes,
		returned_bytes: returnedBytes,
		...(keepLog ? { full_output_path: input.fullOutputPath } : {}),
		capture_complete: input.captureComplete,
	};
	const header = formatHeader(details);
	return { content: body ? `${header}\n${body}` : header, details, keepLog };
}

export function cleanForModel(text: string, format: BashOutputFormat): { text: string; compacted: boolean } {
	let compacted = false;
	let value = stripVTControlCharacters(text);
	value = value.replace(/\r\n/g, "\n");
	const progress = foldCarriageProgress(value);
	value = progress.text;
	compacted ||= progress.compacted;
	value = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (char) => visibleControl(char));

	if (format === "text") {
		const empty = collapseBlankLines(value);
		value = empty.text;
		compacted ||= empty.compacted;
		const repeated = collapseRepeatedLines(value);
		value = repeated.text;
		compacted ||= repeated.compacted;
	}
	return { text: value, compacted };
}

export function detectOutputFormat(text: string): BashOutputFormat {
	const trimmed = stripVTControlCharacters(text).trimStart();
	if (trimmed.length === 0) return "text";
	if (/^(diff --git |--- .+\n\+\+\+ |@@ )/m.test(trimmed)) return "diff";
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
	if (trimmed.startsWith("<") && /<([A-Za-z_:][\w:.-]*)(\s|>|\/>)/.test(trimmed.slice(0, 200))) return "xml";
	return "text";
}

export function countLogicalLines(text: string): number {
	if (text.length === 0) return 0;
	const breaks = (text.match(/\n/g) ?? []).length;
	return breaks + (text.endsWith("\n") ? 0 : 1);
}

function formatHeader(details: BashToolDetails): string {
	const duration = (details.duration_ms / 1000).toFixed(2);
	const outputTruncated = details.output_state === "truncated" || details.output_state === "capture_truncated";
	const fullPart = outputTruncated && details.full_output_path ? ` full=${details.full_output_path}` : "";
	if (details.status === "timed_out") {
		return `[timeout duration=${duration}s output=${details.output_state}${fullPart}]`;
	}
	if (details.status === "aborted") {
		return `[aborted duration=${duration}s output=${details.output_state}${fullPart}]`;
	}
	return `[exit=${details.exit_code ?? "null"} duration=${duration}s output=${details.output_state}${fullPart}]`;
}

function headTailPreview(text: string, budget: number, headRatio: number): string {
	const marker = "\n[... lines omitted ...]\n";
	const markerBudget = Buffer.byteLength(marker, "utf8") + 24;
	const headBudget = Math.max(Math.min(32, Math.floor(budget / 2)), Math.floor((budget - markerBudget) * headRatio));
	const tailBudget = Math.max(0, budget - markerBudget - headBudget);
	const head = takeHeadBytes(text, headBudget).replace(/\n*$/, "");
	const tail = takeTailBytes(text, tailBudget).replace(/^\n*/, "");
	const omittedLines = Math.max(0, countLogicalLines(text) - countLogicalLines(head) - countLogicalLines(tail));
	return ensureByteLimit(`${head}\n[... ${omittedLines} lines omitted ...]\n${tail}`, budget);
}

function failurePreview(text: string, budget: number): string {
	const lines = splitLines(text);
	const windows = diagnosticWindows(lines);
	if (windows.length === 0) return headTailPreview(text, budget, 0.15);

	const head = byteLimitedLines(lines, 0, Math.floor(budget * 0.15));
	const tail = byteLimitedTailLines(lines, Math.floor(budget * 0.2));
	const ranges = mergeRanges([
		...(head.length > 0 ? [{ start: 0, end: head.length - 1 }] : []),
		...windows,
		...(tail.length > 0 ? [{ start: lines.length - tail.length, end: lines.length - 1 }] : []),
	]);
	let rendered = renderRanges(lines, ranges);
	if (Buffer.byteLength(rendered, "utf8") > budget) {
		const diagnostic = windows.length === 1 ? windows : [windows[0]!, windows[windows.length - 1]!];
		rendered = renderRanges(lines, mergeRanges([...(head.length ? [{ start: 0, end: head.length - 1 }] : []), ...diagnostic, ...(tail.length ? [{ start: lines.length - tail.length, end: lines.length - 1 }] : [])]));
	}
	return ensureByteLimit(rendered, budget);
}

function structuredPreview(text: string, format: BashOutputFormat, budget: number): string {
	const label = format === "binary" ? "binary/text preview" : `${format} preview; this is not a complete ${format.toUpperCase()} document`;
	const header = `[${label}]\n\n`;
	const marker = "\n\n[... bytes omitted ...]\n\n";
	const available = Math.max(0, budget - Buffer.byteLength(header + marker, "utf8"));
	const head = takeHeadBytes(text, Math.floor(available * 0.25));
	const tail = takeTailBytes(text, Math.ceil(available * 0.75));
	const omitted = Math.max(0, Buffer.byteLength(text, "utf8") - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"));
	return ensureByteLimit(`${header}${head}\n\n[... ${omitted} bytes omitted ...]\n\n${tail}`, budget);
}

function foldCarriageProgress(text: string): { text: string; compacted: boolean } {
	let compacted = false;
	const lines = text.split("\n").map((line) => {
		const parts = line.split("\r");
		if (parts.length <= 1) return line;
		compacted = true;
		const final = parts[parts.length - 1] ?? "";
		const omitted = parts.length - 1;
		return `${final} [${omitted} progress updates omitted]`;
	});
	return { text: lines.join("\n"), compacted };
}

function collapseRepeatedLines(text: string): { text: string; compacted: boolean } {
	const lines = text.split("\n");
	const result: string[] = [];
	let compacted = false;
	for (let index = 0; index < lines.length; ) {
		const line = lines[index] ?? "";
		let next = index + 1;
		while (next < lines.length && lines[next] === line) next += 1;
		const count = next - index;
		result.push(line);
		if (count >= 3 && line !== "") {
			result.push(`[same line repeated ${count - 1} more times]`);
			compacted = true;
		} else {
			for (let repeat = 1; repeat < count; repeat += 1) result.push(line);
		}
		index = next;
	}
	return { text: result.join("\n"), compacted };
}

function collapseBlankLines(text: string): { text: string; compacted: boolean } {
	const lines = text.split("\n");
	const result: string[] = [];
	let blankRun = 0;
	let compacted = false;
	for (const line of lines) {
		if (line === "") {
			blankRun += 1;
			if (blankRun <= 2) result.push(line);
			else compacted = true;
		} else {
			blankRun = 0;
			result.push(line);
		}
	}
	return { text: result.join("\n"), compacted };
}

function diagnosticWindows(lines: string[]): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (!ERROR_ANCHORS.test(lines[index] ?? "")) continue;
		ranges.push({ start: Math.max(0, index - 2), end: Math.min(lines.length - 1, index + 3) });
	}
	return mergeRanges(ranges);
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
	const sorted = ranges.filter((range) => range.end >= range.start).sort((a, b) => a.start - b.start);
	const result: Array<{ start: number; end: number }> = [];
	for (const range of sorted) {
		const previous = result[result.length - 1];
		if (!previous || range.start > previous.end + 1) {
			result.push({ ...range });
		} else {
			previous.end = Math.max(previous.end, range.end);
		}
	}
	return result;
}

function renderRanges(lines: string[], ranges: Array<{ start: number; end: number }>): string {
	const parts: string[] = [];
	let previousEnd = -1;
	for (const range of ranges) {
		const omitted = range.start - previousEnd - 1;
		if (omitted > 0) parts.push(`[... ${omitted} lines omitted ...]`);
		for (let index = range.start; index <= range.end; index += 1) {
			const line = lines[index];
			if (line !== undefined) parts.push(line);
		}
		previousEnd = range.end;
	}
	const tailOmitted = lines.length - previousEnd - 1;
	if (tailOmitted > 0) parts.push(`[... ${tailOmitted} lines omitted ...]`);
	return parts.join("\n");
}

function byteLimitedLines(lines: string[], start: number, budget: number): string[] {
	const result: string[] = [];
	let used = 0;
	for (let index = start; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined) break;
		const size = Buffer.byteLength(`${line}\n`, "utf8");
		if (used + size > budget) break;
		result.push(line);
		used += size;
	}
	return result;
}

function byteLimitedTailLines(lines: string[], budget: number): string[] {
	const result: string[] = [];
	let used = 0;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (line === undefined) break;
		const size = Buffer.byteLength(`${line}\n`, "utf8");
		if (used + size > budget) break;
		result.unshift(line);
		used += size;
	}
	return result;
}

function splitLines(text: string): string[] {
	return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

function visibleControl(char: string): string {
	return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
}

function ensureByteLimit(text: string, budget: number): string {
	if (Buffer.byteLength(text, "utf8") <= budget) return text;
	const marker = "\n[... output truncated to byte budget ...]\n";
	const remaining = Math.max(0, budget - Buffer.byteLength(marker, "utf8"));
	return takeHeadBytes(text, Math.floor(remaining * 0.2)) + marker + takeTailBytes(text, Math.ceil(remaining * 0.8));
}

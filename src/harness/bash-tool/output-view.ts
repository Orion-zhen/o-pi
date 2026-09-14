import { stripVTControlCharacters } from "node:util";

import { countLogicalLines, renderOutputPreview, renderSplitPreview } from "./output-preview.js";
import { decodeUtf8Prefix, trimLeadingUtf8Continuation } from "./utf8.js";
import type { BashLimits, BashOutputFormat, BashOutputState, BashRunStatus, BashToolDetails, CapturedOutput } from "./types.js";

interface OutputViewInput extends CapturedOutput {
	status: BashRunStatus;
	exitCode?: number;
	durationMs: number;
	limits: BashLimits;
}

interface OutputView {
	content: string;
	details: BashToolDetails;
	keepLog: boolean;
}

/** 生成模型可见的有界输出，不修改原始日志，也不推测原始片段是否连续。 */
export function createBashOutputView(input: OutputViewInput): OutputView {
	const failed = input.status !== "exited" || input.exitCode !== 0;
	const budget = failed ? input.limits.failure_output_bytes : input.limits.success_output_bytes;
	const preview = input.preview;
	const head = preview.kind === "complete" ? preview.bytes.toString("utf8") : decodeUtf8Prefix(preview.head);
	const tail = preview.kind === "complete" ? "" : trimLeadingUtf8Continuation(preview.tail).toString("utf8");
	const format = input.binary ? "binary" : detectOutputFormat(head + (tail ? `\n${tail}` : ""));
	const cleanedHead = cleanForModel(head, format);
	const cleanedTail = cleanForModel(tail, format);
	const truncated = preview.kind === "split" || Buffer.byteLength(cleanedHead.text) > budget;
	const body = preview.kind === "complete"
		? renderOutputPreview(cleanedHead.text, format, budget, failed)
		: renderSplitPreview(cleanedHead.text, cleanedTail.text, preview.omittedBytes, format, budget, failed);
	const outputState: BashOutputState = !input.captureComplete ? "capture_truncated"
		: truncated ? "truncated"
		: cleanedHead.compacted ? "compacted" : "complete";
	const returnedBytes = Buffer.byteLength(body);
	// 大小限制由展示边界负责，选择器不得依赖再次裁剪来满足预算。
	if (returnedBytes > budget) throw new Error("Bash output preview exceeded its byte budget.");
	const keepLog = outputState !== "complete" || failed;
	const details: BashToolDetails = {
		status: input.status,
		...(input.exitCode !== undefined ? { exit_code: input.exitCode } : {}),
		duration_ms: input.durationMs,
		output_state: outputState,
		output_format: format,
		total_lines: input.totalLines,
		returned_lines: countLogicalLines(body),
		total_bytes: input.totalBytes,
		returned_bytes: returnedBytes,
		...(keepLog ? { full_output_path: input.logPath } : {}),
		capture_complete: input.captureComplete,
	};
	const header = formatHeader(details);
	return { content: body ? `${header}\n${body}` : header, details, keepLog };
}

export function cleanForModel(text: string, format: BashOutputFormat): { text: string; compacted: boolean } {
	let value = stripVTControlCharacters(text).replace(/\r\n/g, "\n");
	const progress = foldCarriageProgress(value);
	value = progress.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
	let compacted = progress.compacted;
	if (format === "text") {
		const empty = collapseBlankLines(value);
		const repeated = collapseRepeatedLines(empty.text);
		value = repeated.text;
		compacted ||= empty.compacted || repeated.compacted;
	}
	return { text: value, compacted };
}

function detectOutputFormat(text: string): BashOutputFormat {
	const trimmed = stripVTControlCharacters(text).trimStart();
	if (/^(diff --git |--- .+\n\+\+\+ |@@ )/m.test(trimmed)) return "diff";
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
	if (trimmed.startsWith("<") && /<([A-Za-z_:][\w:.-]*)(\s|>|\/>)/.test(trimmed.slice(0, 200))) return "xml";
	return "text";
}

function formatHeader(details: BashToolDetails): string {
	const duration = (details.duration_ms / 1000).toFixed(2);
	const outputTruncated = details.output_state === "truncated" || details.output_state === "capture_truncated";
	const fullPart = outputTruncated && details.full_output_path ? ` full=${details.full_output_path}` : "";
	const status = details.status === "timed_out" ? "timeout" : details.status === "aborted" ? "aborted" : `exit=${details.exit_code ?? "null"}`;
	return `[${status} duration=${duration}s output=${details.output_state}${fullPart}]`;
}

function foldCarriageProgress(text: string): { text: string; compacted: boolean } {
	let compacted = false;
	const lines = text.split("\n").map((line) => {
		const finalSeparator = line.lastIndexOf("\r");
		if (finalSeparator === -1) return line;
		compacted = true;
		const omitted = line.split("\r").length - 1;
		return `${line.slice(finalSeparator + 1)} [${omitted} progress updates omitted]`;
	});
	return { text: lines.join("\n"), compacted };
}

function collapseRepeatedLines(text: string): { text: string; compacted: boolean } {
	const result: string[] = [];
	let compacted = false;
	let current = "";
	let count = 0;
	const flush = () => {
		if (count === 0) return;
		result.push(current);
		if (count >= 3 && current !== "") {
			result.push(`[same line repeated ${count - 1} more times]`);
			compacted = true;
		} else {
			for (let repeat = 1; repeat < count; repeat += 1) result.push(current);
		}
	};
	for (const line of text.split("\n")) {
		if (count === 0) {
			current = line;
			count = 1;
		} else if (line === current) {
			count += 1;
		} else {
			flush();
			current = line;
			count = 1;
		}
	}
	flush();
	return { text: result.join("\n"), compacted };
}

function collapseBlankLines(text: string): { text: string; compacted: boolean } {
	const result: string[] = [];
	let blankRun = 0;
	let compacted = false;
	for (const line of text.split("\n")) {
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

import { renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import type { Text } from "@earendil-works/pi-tui";
import { formatToolCard } from "../../../components/tool-card.ts";
import { formatBytes, joinParts } from "../../../components/text.ts";
import { isWriteSuccess } from "../../../../harness/file-tools/write/guards.ts";
import { isPlainRecord } from "../../../../harness/file-tools/pi/guards.ts";
import { isMutationProgress } from "../../../../harness/file-tools/pi/progress.ts";
import type { TextRenderContext, ToolTextResult } from "./contracts.ts";
import { formatDiffStats, formatLspDiagnostics, formatLspSummary, formatMutationPostProcessSummary } from "./diagnostics.ts";
import { displayToolPath, fallbackTextResult, formatFailureCard, stringArg, textComponent } from "./shared.ts";

/** 调用预览和高亮交给 SDK，结果保留差异、LSP 进度与错误正文。 */
export function renderWriteResult(
	result: ToolTextResult,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: TextRenderContext,
): Text {
	const text = textComponent(context.lastComponent);
	const details = result.details;
	if (options.isPartial) {
		const summary = isMutationProgress(details) && details.status === "post-processing"
			? formatMutationPostProcessSummary(details) : "writing";
		text.setText(formatToolCard({ tool: "write", status: "running", target: writeTarget(context.args, context.cwd), summary }, theme));
	} else {
		text.setText(formatWriteResult(result, theme, context.args, context.cwd, options.expanded));
	}
	return text;
}

function formatWriteResult(
	result: ToolTextResult,
	theme: Pick<Theme, "fg" | "bold">,
	args: unknown,
	cwd: string,
	expanded: boolean,
): string {
	const details = result.details;
	if (!isWriteSuccess(details)) {
		return formatFailureCard("write", writeTarget(args, cwd), details, args, expanded, theme)
			?? fallbackTextResult(result, expanded, theme, 10);
	}
	const diff = details.diff;
	const header = formatToolCard({
		tool: "write",
		status: "success",
		target: details.path,
		summary: joinParts(["done", formatDiffStats(diff), formatBytes(details.bytes), formatLspSummary(details.lsp?.diagnostics)]),
	}, theme);
	if (!expanded) return header;
	const renderedDiff = diff === "" ? undefined : renderDiff(diff);
	const diagnostics = formatLspDiagnostics(details.lsp?.diagnostics, theme);
	return [header, renderedDiff, diagnostics].filter((part): part is string => part !== undefined).join("\n\n");
}

function writeTarget(args: unknown, cwd: string): string {
	const record = isPlainRecord(args) ? args : {};
	return displayToolPath(stringArg(record["file_path"] ?? record["path"]), cwd);
}

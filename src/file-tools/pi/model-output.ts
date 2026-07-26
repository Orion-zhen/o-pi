import { isPlainRecord } from "./guards.js";
import type {
	EditSuccess,
	LspDiagnosticsSummary,
	WriteSuccess,
	EditMatchHint,
} from "../types.js";
import type { FailedResult } from "../shared/result.js";

/** 文件工具失败的模型可见结果；完整错误结构保留在 details。 */
export function formatErrorModelResult(result: FailedResult): string {
	const hints = result.error.code === "OLD_TEXT_NOT_UNIQUE" ? formatEditMatchHints(result.error.details) : "";
	const next = result.error.next !== undefined ? `\nnext: ${escapeXmlText(result.error.next)}` : "";
	return `<error>\n${escapeXmlText(result.error.message)}${hints}${next}\n</error>`;
}

/** edit 的模型可见成功结果确认写入事实，并附加有限 LSP 诊断；完整结构保留在 details。 */
export function formatEditModelResult(result: EditSuccess, impact: string | undefined = undefined): string {
	const diagnostics = visibleDiagnostics(result.lsp?.diagnostics);
	const attrs = [
		`path="${escapeXmlAttribute(result.path)}"`,
		`replacements="${result.replacements}"`,
	];
	if (result.firstChangedLine !== undefined) attrs.push(`first_changed_line="${result.firstChangedLine}"`);
	if (diagnostics !== undefined) attrs.push(`lsp="${escapeXmlAttribute(diagnostics.status)}"`);
	if (result.repo_map?.status === "partially_stale") attrs.push('repo_map="partially_stale"');
	return formatMutationModelResult("edit", attrs, diagnostics, impact);
}

export function formatWriteModelResult(result: WriteSuccess, impact: string | undefined = undefined): string {
	const diagnostics = visibleDiagnostics(result.lsp?.diagnostics);
	const attrs = [`path="${escapeXmlAttribute(result.path)}"`];
	if (diagnostics !== undefined) attrs.push(`lsp="${escapeXmlAttribute(diagnostics.status)}"`);
	if (result.repo_map?.status === "partially_stale") attrs.push('repo_map="partially_stale"');
	return formatMutationModelResult("write", attrs, diagnostics, impact);
}

function formatMutationModelResult(
	tool: "edit" | "write",
	attrs: string[],
	diagnostics: LspDiagnosticsSummary | undefined,
	impact: string | undefined,
): string {
	if (diagnostics === undefined) {
		return impact === undefined ? `<${tool} ${attrs.join(" ")}/>` : `<${tool} ${attrs.join(" ")}>
${impact}
</${tool}>`;
	}

	const lines = [
		`<${tool} ${attrs.join(" ")}>`,
		`errors=${diagnostics.file_errors} warnings=${diagnostics.file_warnings} new_errors=${diagnostics.new_errors} new_warnings=${diagnostics.new_warnings}`,
		...formatDiagnosticItems(diagnostics.items, diagnostics.total_items),
		...(impact === undefined ? [] : [impact]),
		`</${tool}>`,
	];
	return lines.join("\n");
}

export function scrubVersions(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(scrubVersions);
	if (value === null || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (key === "version" || key === "old_version" || key === "new_version" || key === "expected" || key === "actual") continue;
		result[key] = scrubVersions(item);
	}
	return result;
}

function visibleDiagnostics(diagnostics: LspDiagnosticsSummary | undefined): LspDiagnosticsSummary | undefined {
	return diagnostics?.status === "errors" || diagnostics?.status === "warnings" ? diagnostics : undefined;
}

function formatDiagnosticItems(items: LspDiagnosticsSummary["items"], totalItems: number): string[] {
	const visible = items.map((item) => {
		const code = item.code !== undefined ? ` (${item.code})` : "";
		return `diag ${item.severity} ${item.line}:${item.column} ${escapeXmlText(item.message)}${escapeXmlText(code)}`;
	});
	const remaining = Math.max(0, totalItems - items.length);
	if (remaining > 0) visible.push(`... ${remaining} more diagnostics`);
	return visible;
}

function formatEditMatchHints(details: Record<string, unknown> | undefined): string {
	if (details === undefined || !Array.isArray(details["hints"])) return "";
	const hints = details["hints"].filter((value): value is EditMatchHint => isEditMatchHint(value));
	if (hints.length === 0) return "";
	return `\n${hints.map((hint) => `line ${hint.line} old=${JSON.stringify(hint.old)} new=${JSON.stringify(hint.new)}`).map(escapeXmlText).join("\n")}`;
}

function isEditMatchHint(value: unknown): value is EditMatchHint {
	return isPlainRecord(value)
		&& typeof value["line"] === "number"
		&& typeof value["old"] === "string"
		&& typeof value["new"] === "string";
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function escapeXmlText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

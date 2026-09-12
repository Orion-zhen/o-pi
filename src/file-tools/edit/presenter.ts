import { escapeXmlAttribute, relatedDiagnosticLines } from "../shared/mutation-presenter.js";
import type { LspDiagnosticsSummary as DiagnosticsSummary } from "../../lsp/types.js";
import type { EditSuccess } from "./types.js";

export function formatEditModelResult(result: EditSuccess): string {
	const diagnostics = [
		...editDiagnostics(result.lsp?.diagnostics),
		...relatedDiagnosticLines(result.lsp?.diagnostics).map(escapeXmlText),
	];
	const attrs = [
		`path="${escapeXmlAttribute(result.path)}"`,
		`replacements="${result.replacements}"`,
	];
	if (result.firstChangedLine !== undefined) attrs.push(`first_changed_line="${result.firstChangedLine}"`);
	if (diagnostics.length === 0) return `<edit ${attrs.join(" ")}/>`;
	return [`<edit ${attrs.join(" ")}>`, ...diagnostics, "</edit>"].join("\n");
}

function editDiagnostics(diagnostics: DiagnosticsSummary | undefined): string[] {
	if (diagnostics === undefined) return [];
	if (diagnostics.status === "timeout" || diagnostics.status === "unavailable") return [`diag ${diagnostics.status}`];
	const lines = diagnostics.file_errors > 0 ? [`errors=${diagnostics.file_errors}`] : [];
	const uncertain = diagnostics.baseline === "unknown";
	for (const item of diagnostics.items) {
		if (item.severity !== "error" && item.severity !== "warning") continue;
		const prefix = item.change === undefined ? item.severity : `${item.change} ${item.severity}`;
		const certainty = uncertain ? " (causality uncertain)" : "";
		const code = item.code === undefined ? "" : ` (${escapeXmlText(item.code)})`;
		lines.push(`${prefix} at line ${item.line}${certainty}: ${escapeXmlText(item.message)}${code}`);
		if (item.hint !== undefined) lines.push(`hint: ${escapeXmlText(item.hint)}`);
	}
	const remaining = Math.max(0, diagnostics.total_items - diagnostics.items.length);
	if (remaining > 0) lines.push(`... ${remaining} more diagnostics`);
	return lines;
}

function escapeXmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

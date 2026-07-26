import type { DiagnosticsSummary } from "./diagnostics.js";

export function formatMutationResult(
	tool: "edit" | "write",
	attrs: readonly string[],
	diagnostics: DiagnosticsSummary | undefined,
	impact: string | undefined,
): string {
	if (diagnostics === undefined) {
		return impact === undefined ? `<${tool} ${attrs.join(" ")}/>` : `<${tool} ${attrs.join(" ")}>\n${impact}\n</${tool}>`;
	}
	return [
		`<${tool} ${attrs.join(" ")}>`,
		`errors=${diagnostics.file_errors} warnings=${diagnostics.file_warnings} new_errors=${diagnostics.new_errors} new_warnings=${diagnostics.new_warnings}`,
		...formatDiagnosticItems(diagnostics.items, diagnostics.total_items),
		...(impact === undefined ? [] : [impact]),
		`</${tool}>`,
	].join("\n");
}

export function visibleDiagnostics(diagnostics: DiagnosticsSummary | undefined): DiagnosticsSummary | undefined {
	return diagnostics?.status === "errors" || diagnostics?.status === "warnings" ? diagnostics : undefined;
}

export function escapeXmlAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDiagnosticItems(items: DiagnosticsSummary["items"], totalItems: number): string[] {
	const visible = items.map((item) => {
		const code = item.code === undefined ? "" : ` (${item.code})`;
		return `diag ${item.severity} ${item.line}:${item.column} ${escapeXmlText(item.message)}${escapeXmlText(code)}`;
	});
	const remaining = Math.max(0, totalItems - items.length);
	if (remaining > 0) visible.push(`... ${remaining} more diagnostics`);
	return visible;
}

function escapeXmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

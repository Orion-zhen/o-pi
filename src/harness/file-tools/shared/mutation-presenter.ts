import type { LspDiagnosticsSummary as DiagnosticsSummary } from "../../lsp/types.ts";

export function formatMutationResult(
	tool: "edit" | "write",
	attrs: readonly string[],
	diagnostics: DiagnosticsSummary | undefined,
): string {
	if (diagnostics === undefined || diagnostics.status === "timeout" || diagnostics.status === "unavailable") {
		return `<${tool} ${attrs.join(" ")}/>`;
	}
	return [
		`<${tool} ${attrs.join(" ")}>`,
		`errors=${diagnostics.file_errors} warnings=${diagnostics.file_warnings}`,
		...formatDiagnosticItems(diagnostics.items, diagnostics.total_items),
		...relatedDiagnosticLines(diagnostics).map(escapeXmlText),
		`</${tool}>`,
	].join("\n");
}

export function visibleDiagnostics(diagnostics: DiagnosticsSummary | undefined): DiagnosticsSummary | undefined {
	return diagnostics !== undefined && (diagnostics.status !== "clean" || (diagnostics.related?.length ?? 0) > 0) ? diagnostics : undefined;
}

export function relatedDiagnosticLines(diagnostics: DiagnosticsSummary | undefined): string[] {
	return (diagnostics?.related ?? []).flatMap((file) => file.items.map((item) => {
		const certainty = file.baseline === "known" ? "new error" : "error (causality uncertain)";
		const code = item.code === undefined ? "" : ` (${item.code})`;
		return `related ${certainty} ${file.path}:${item.line}:${item.column}: ${item.message}${code}`;
	}));
}

export function escapeXmlAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDiagnosticItems(items: DiagnosticsSummary["items"], totalItems: number): string[] {
	const visible = items.flatMap((item) => {
		const code = item.code === undefined ? "" : ` (${item.code})`;
		const prefix = item.change === undefined ? item.severity : `${item.change} ${item.severity}`;
		return [
			`diag ${prefix} ${item.line}:${item.column} ${escapeXmlText(item.message)}${escapeXmlText(code)}`,
			...(item.hint === undefined ? [] : [`hint: ${escapeXmlText(item.hint)}`]),
		];
	});
	const remaining = Math.max(0, totalItems - items.length);
	if (remaining > 0) visible.push(`... ${remaining} more diagnostics`);
	return visible;
}

function escapeXmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

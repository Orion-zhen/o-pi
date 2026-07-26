import type { Theme } from "@earendil-works/pi-coding-agent";
import type { LspDiagnosticsSummary } from "../../types.js";

export function formatDiffStats(diff: string): string {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
	}
	return `+${added} -${removed}`;
}

export function formatLspSummary(diagnostics: LspDiagnosticsSummary | undefined): string | undefined {
	if (!hasVisibleLspDiagnostics(diagnostics)) return undefined;
	return diagnostics.status === "errors"
		? `LSP ${diagnostics.file_errors} errors`
		: `LSP ${diagnostics.file_warnings} warnings`;
}

export function formatLspDiagnostics(
	diagnostics: LspDiagnosticsSummary | undefined,
	theme: Pick<Theme, "fg">,
): string | undefined {
	if (!hasVisibleLspDiagnostics(diagnostics) || (diagnostics.items.length === 0 && diagnostics.total_items === 0)) return undefined;
	const lines = diagnostics.items.map((item) => theme.fg("toolOutput", `${item.severity} ${item.line}:${item.column} ${item.message}${item.code !== undefined ? ` (${item.code})` : ""}`));
	const remaining = Math.max(0, diagnostics.total_items - diagnostics.items.length);
	if (remaining > 0) lines.push(theme.fg("toolOutput", `... ${remaining} more diagnostics`));
	return lines.join("\n");
}

function hasVisibleLspDiagnostics(
	diagnostics: LspDiagnosticsSummary | undefined,
): diagnostics is LspDiagnosticsSummary & { status: "errors" | "warnings" } {
	return diagnostics?.status === "errors" || diagnostics?.status === "warnings";
}

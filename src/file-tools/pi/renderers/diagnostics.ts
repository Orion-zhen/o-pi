import type { Theme } from "@earendil-works/pi-coding-agent";
import type { DiagnosticsSummary, DiagnosticStatus } from "../../shared/diagnostics.js";
import type { MutationPostProcessProgressDetails } from "../progress.js";

export function formatDiffStats(diff: string): string {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
	}
	return `+${added} -${removed}`;
}

export function formatLspSummary(diagnostics: DiagnosticsSummary | undefined): string {
	return formatLspStatus(
		diagnostics?.status ?? "unavailable",
		diagnostics?.file_errors ?? 0,
		diagnostics?.file_warnings ?? 0,
	);
}

export function formatMutationPostProcessSummary(progress: MutationPostProcessProgressDetails): string {
	return progress.lsp.status === "pending"
		? "LSP pending"
		: progress.lsp.status === "running"
			? "LSP checking"
			: formatLspStatus(progress.lsp.status, progress.lsp.errors, progress.lsp.warnings);
}

export function formatEditDiagnostics(
	diagnostics: DiagnosticsSummary | undefined,
	theme: Pick<Theme, "fg">,
): string | undefined {
	if (diagnostics === undefined || diagnostics.items.length === 0) return undefined;
	const uncertain = diagnostics.baseline === "unknown";
	const lines = diagnostics.items
		.filter((item) => item.severity === "error" || item.severity === "warning")
		.map((item) => {
			const prefix = uncertain ? item.severity : `new ${item.severity}`;
			const certainty = uncertain ? " (causality uncertain)" : "";
			const code = item.code === undefined ? "" : ` (${item.code})`;
			return theme.fg("toolOutput", `${prefix} at line ${item.line}${certainty}: ${item.message}${code}`);
		});
	return lines.length === 0 ? undefined : lines.join("\n");
}

export function formatLspDiagnostics(
	diagnostics: DiagnosticsSummary | undefined,
	theme: Pick<Theme, "fg">,
): string | undefined {
	if (!hasVisibleLspDiagnostics(diagnostics) || (diagnostics.items.length === 0 && diagnostics.total_items === 0)) return undefined;
	const lines = diagnostics.items.map((item) => theme.fg("toolOutput", `${item.severity} ${item.line}:${item.column} ${item.message}${item.code !== undefined ? ` (${item.code})` : ""}`));
	const remaining = Math.max(0, diagnostics.total_items - diagnostics.items.length);
	if (remaining > 0) lines.push(theme.fg("toolOutput", `... ${remaining} more diagnostics`));
	return lines.join("\n");
}

function formatLspStatus(status: DiagnosticStatus, errors: number, warnings: number): string {
	if (status === "errors") return `LSP ${errors} errors`;
	if (status === "warnings") return `LSP ${warnings} warnings`;
	return `LSP ${status}`;
}

function hasVisibleLspDiagnostics(
	diagnostics: DiagnosticsSummary | undefined,
): diagnostics is DiagnosticsSummary & { status: "errors" | "warnings" } {
	return diagnostics?.status === "errors" || diagnostics?.status === "warnings";
}

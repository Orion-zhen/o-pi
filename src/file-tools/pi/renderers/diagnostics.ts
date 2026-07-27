import type { Theme } from "@earendil-works/pi-coding-agent";
import type { DiagnosticsSummary, DiagnosticStatus } from "../../shared/diagnostics.js";
import type { MutationPostProcessProgressDetails, MutationRepoMapProgressStatus } from "../progress.js";

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
	const lsp = progress.lsp.status === "pending"
		? "LSP pending"
		: progress.lsp.status === "running"
			? "LSP checking"
			: formatLspStatus(progress.lsp.status, progress.lsp.errors, progress.lsp.warnings);
	return `${lsp} · ${formatRepoMapProgress(progress.repo_map)}`;
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

function formatRepoMapProgress(status: MutationRepoMapProgressStatus): string {
	if (status === "pending") return "Repo Map pending";
	if (status === "running") return "Repo Map updating";
	if (status === "partially_stale") return "Repo Map partially stale";
	return `Repo Map ${status}`;
}

function hasVisibleLspDiagnostics(
	diagnostics: DiagnosticsSummary | undefined,
): diagnostics is DiagnosticsSummary & { status: "errors" | "warnings" } {
	return diagnostics?.status === "errors" || diagnostics?.status === "warnings";
}

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { LspDiagnosticsSummary as DiagnosticsSummary } from "../../../../harness/lsp/types.js";
import { relatedDiagnosticLines } from "../../../../harness/file-tools/shared/mutation-presenter.js";
import type { MutationPostProcessProgressDetails } from "../../../../harness/file-tools/pi/progress.js";

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
	if (diagnostics?.related !== undefined && diagnostics.related.length > 0) {
		const count = diagnostics.related.reduce((total, file) => total + file.items.length, 0);
		return `LSP ${diagnostics.file_errors} errors, ${count} related errors`;
	}
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
	if (diagnostics === undefined) return undefined;
	const uncertain = diagnostics.baseline === "unknown";
	const lines = diagnostics.items
		.filter((item) => item.severity === "error" || item.severity === "warning")
		.flatMap((item) => {
			const prefix = item.change === undefined ? item.severity : `${item.change} ${item.severity}`;
			const certainty = uncertain ? " (causality uncertain)" : "";
			const code = item.code === undefined ? "" : ` (${item.code})`;
			return [
				theme.fg("toolOutput", `${prefix} at line ${item.line}${certainty}: ${item.message}${code}`),
				...(item.hint === undefined ? [] : [theme.fg("toolOutput", `hint: ${item.hint}`)]),
			];
		});
	const remaining = Math.max(0, diagnostics.total_items - diagnostics.items.length);
	if (remaining > 0) lines.push(theme.fg("toolOutput", `... ${remaining} more diagnostics`));
	lines.push(...relatedDiagnosticLines(diagnostics).map((line) => theme.fg("toolOutput", line)));
	return lines.length === 0 ? undefined : lines.join("\n");
}

export function formatLspDiagnostics(
	diagnostics: DiagnosticsSummary | undefined,
	theme: Pick<Theme, "fg">,
): string | undefined {
	if (diagnostics === undefined) return undefined;
	if (diagnostics.status !== "errors" && diagnostics.status !== "warnings" && (diagnostics.related?.length ?? 0) === 0) return undefined;
	const lines = diagnostics.items.flatMap((item) => [
		theme.fg("toolOutput", `${item.change === undefined ? "" : `${item.change} `}${item.severity} ${item.line}:${item.column} ${item.message}${item.code !== undefined ? ` (${item.code})` : ""}`),
		...(item.hint === undefined ? [] : [theme.fg("toolOutput", `hint: ${item.hint}`)]),
	]);
	const remaining = Math.max(0, diagnostics.total_items - diagnostics.items.length);
	if (remaining > 0) lines.push(theme.fg("toolOutput", `... ${remaining} more diagnostics`));
	lines.push(...relatedDiagnosticLines(diagnostics).map((line) => theme.fg("toolOutput", line)));
	return lines.length === 0 ? undefined : lines.join("\n");
}

function formatLspStatus(status: DiagnosticsSummary["status"], errors: number, warnings: number): string {
	if (status === "clean") return "";
	if (status === "errors") return `LSP ${errors} errors`;
	if (status === "warnings") return `LSP ${warnings} warnings`;
	return `LSP ${status}`;
}

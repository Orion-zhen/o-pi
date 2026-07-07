import type { Diagnostic } from "vscode-languageserver-protocol";
import { DiagnosticSeverity } from "vscode-languageserver-protocol";
import type { LspDiagnosticItem, LspDiagnosticSnapshot, LspDiagnosticsSummary, LspSeverityName } from "./types.js";

const severityOrder: Record<LspSeverityName, number> = {
	error: 1,
	warning: 2,
	information: 3,
	hint: 4,
};

/** 保存 LSP 诊断快照，并提供写入/编辑后的 compact diff。 */
export class DiagnosticsLedger {
	private readonly itemsByUri = new Map<string, LspDiagnosticItem[]>();
	private readonly updatedAtByUri = new Map<string, number>();

	update(uri: string, diagnostics: readonly Diagnostic[], minSeverity: LspSeverityName): void {
		this.itemsByUri.set(uri, diagnostics.map(toItem).filter((item) => severityOrder[item.severity] <= severityOrder[minSeverity]));
		this.updatedAtByUri.set(uri, Date.now());
	}

	clear(): void {
		this.itemsByUri.clear();
		this.updatedAtByUri.clear();
	}

	snapshot(uri: string): LspDiagnosticSnapshot {
		const items = this.itemsByUri.get(uri);
		return { uri, items: items === undefined ? [] : items.map((item) => ({ ...item })), known: items !== undefined };
	}

	lastUpdatedAt(uri: string): number | undefined {
		return this.updatedAtByUri.get(uri);
	}

	count(uri: string): number {
		return this.itemsByUri.get(uri)?.length ?? 0;
	}

	all(): Array<{ uri: string; items: LspDiagnosticItem[] }> {
		return Array.from(this.itemsByUri.entries()).map(([uri, items]) => ({ uri, items: items.map((item) => ({ ...item })) }));
	}
}

export function summarizeDiagnostics(
	after: LspDiagnosticSnapshot,
	baseline: LspDiagnosticSnapshot | undefined,
	maxItems: number,
	overrideStatus?: "unavailable" | "timeout",
): LspDiagnosticsSummary {
	if (overrideStatus !== undefined) return emptySummary(overrideStatus, baseline?.known === true ? "known" : "unknown");
	const baselineKnown = baseline?.known === true;
	const beforeItems = baseline?.items ?? [];
	const beforeKeys = countKeys(beforeItems);
	const afterKeys = countKeys(after.items);
	const diff = diffCounts(beforeKeys, afterKeys);
	const fileErrors = after.items.filter((item) => item.severity === "error").length;
	const fileWarnings = after.items.filter((item) => item.severity === "warning").length;
	return {
		status: fileErrors > 0 ? "errors" : fileWarnings > 0 ? "warnings" : "clean",
		file_errors: fileErrors,
		file_warnings: fileWarnings,
		new_errors: diff.new_errors,
		new_warnings: diff.new_warnings,
		resolved_errors: diff.resolved_errors,
		resolved_warnings: diff.resolved_warnings,
		baseline: baselineKnown ? "known" : "unknown",
		items: after.items.slice(0, maxItems).map((item) => ({ ...item })),
	};
}

export function emptySummary(status: "unavailable" | "timeout", baseline: "known" | "unknown" = "unknown"): LspDiagnosticsSummary {
	return {
		status,
		file_errors: 0,
		file_warnings: 0,
		new_errors: 0,
		new_warnings: 0,
		resolved_errors: 0,
		resolved_warnings: 0,
		baseline,
		items: [],
	};
}

export function severityName(value: DiagnosticSeverity | undefined): LspSeverityName {
	if (value === DiagnosticSeverity.Error) return "error";
	if (value === DiagnosticSeverity.Warning) return "warning";
	if (value === DiagnosticSeverity.Information) return "information";
	return "hint";
}

function toItem(diagnostic: Diagnostic): LspDiagnosticItem {
	const item: LspDiagnosticItem = {
		severity: severityName(diagnostic.severity),
		line: diagnostic.range.start.line + 1,
		column: diagnostic.range.start.character + 1,
		message: normalizeMessage(diagnosticMessage(diagnostic.message)),
	};
	if (diagnostic.code !== undefined) item.code = String(diagnostic.code);
	if (diagnostic.source !== undefined) item.source = diagnostic.source;
	return item;
}

function countKeys(items: readonly LspDiagnosticItem[]): Map<string, number> {
	const result = new Map<string, number>();
	for (const item of items) result.set(diffKey(item), (result.get(diffKey(item)) ?? 0) + 1);
	return result;
}

function diffCounts(before: Map<string, number>, after: Map<string, number>) {
	let newErrors = 0;
	let newWarnings = 0;
	let resolvedErrors = 0;
	let resolvedWarnings = 0;
	for (const [key, afterCount] of after.entries()) {
		const delta = afterCount - (before.get(key) ?? 0);
		if (delta <= 0) continue;
		if (key.startsWith("error|")) newErrors += delta;
		else if (key.startsWith("warning|")) newWarnings += delta;
	}
	for (const [key, beforeCount] of before.entries()) {
		const delta = beforeCount - (after.get(key) ?? 0);
		if (delta <= 0) continue;
		if (key.startsWith("error|")) resolvedErrors += delta;
		else if (key.startsWith("warning|")) resolvedWarnings += delta;
	}
	return {
		new_errors: newErrors,
		new_warnings: newWarnings,
		resolved_errors: resolvedErrors,
		resolved_warnings: resolvedWarnings,
	};
}

function diffKey(item: LspDiagnosticItem): string {
	return [item.severity, item.line, item.column, item.code ?? "", normalizeMessage(item.message)].join("|");
}

function normalizeMessage(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function diagnosticMessage(value: Diagnostic["message"]): string {
	return typeof value === "string" ? value : value.value;
}

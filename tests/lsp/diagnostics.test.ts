import { describe, expect, it } from "vitest";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";

import { DiagnosticsLedger, summarizeDiagnostics } from "../../src/lsp/diagnostics.js";

const uri = "file:///repo/a.ts";

describe("lsp diagnostics", () => {
	it("计算新增和已解决诊断", () => {
		const ledger = new DiagnosticsLedger();
		ledger.update(uri, [diag(DiagnosticSeverity.Error, 1, 2, "old error"), diag(DiagnosticSeverity.Warning, 3, 1, "old warning")], "warning");
		const before = ledger.snapshot(uri);
		ledger.update(uri, [diag(DiagnosticSeverity.Error, 1, 2, "old error"), diag(DiagnosticSeverity.Error, 4, 1, "new error")], "warning");

		expect(summarizeDiagnostics(ledger.snapshot(uri), before, 10)).toMatchObject({
			status: "errors",
			file_errors: 2,
			file_warnings: 0,
			new_errors: 1,
			resolved_warnings: 1,
			baseline: "known",
		});
	});

	it("限制 max_items 并按 min_severity 过滤", () => {
		const ledger = new DiagnosticsLedger();
		ledger.update(
			uri,
			[
				diag(DiagnosticSeverity.Error, 1, 1, "e1"),
				diag(DiagnosticSeverity.Warning, 2, 1, "w1"),
				diag(DiagnosticSeverity.Information, 3, 1, "i1"),
			],
			"warning",
		);
		const summary = summarizeDiagnostics(ledger.snapshot(uri), undefined, 1);
		expect(summary.total_items).toBe(2);
		expect(summary.items).toHaveLength(1);
		expect(summary.items[0]).toMatchObject({ severity: "error", line: 1, column: 1 });
		expect(JSON.stringify(summary)).not.toContain("i1");
	});

	it("没有 baseline 时标记 unknown", () => {
		const ledger = new DiagnosticsLedger();
		ledger.update(uri, [diag(DiagnosticSeverity.Warning, 1, 1, "w")], "warning");
		expect(summarizeDiagnostics(ledger.snapshot(uri), undefined, 10)).toMatchObject({
			status: "warnings",
			baseline: "unknown",
			new_warnings: 1,
		});
	});
});

function diag(severity: DiagnosticSeverity, line: number, column: number, message: string): Diagnostic {
	return {
		severity,
		range: {
			start: { line: line - 1, character: column - 1 },
			end: { line: line - 1, character: column },
		},
		message,
		source: "test",
	};
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";

import { DiagnosticsLedger, summarizeDiagnostics } from "../../src/lsp/diagnostics.js";

const source = "/repo\0ts";
const otherSource = "/other\0ts";
const uri = "file:///repo/a.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("lsp diagnostics", () => {
	it("计算同 source baseline 的新增和已解决诊断", () => {
		const ledger = new DiagnosticsLedger();
		ledger.update(source, uri, [diag(DiagnosticSeverity.Error, 1, 2, "old error"), diag(DiagnosticSeverity.Warning, 3, 1, "old warning")], "warning");
		const before = ledger.snapshot(source, uri);
		ledger.update(source, uri, [diag(DiagnosticSeverity.Error, 1, 2, "old error"), diag(DiagnosticSeverity.Error, 4, 1, "new error")], "warning");

		expect(summarizeDiagnostics(ledger.snapshot(source, uri), before, 10)).toMatchObject({
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
			source,
			uri,
			[
				diag(DiagnosticSeverity.Error, 1, 1, "e1"),
				diag(DiagnosticSeverity.Warning, 2, 1, "w1"),
				diag(DiagnosticSeverity.Information, 3, 1, "i1"),
			],
			"warning",
		);
		const summary = summarizeDiagnostics(ledger.snapshot(source, uri), undefined, 1);
		expect(summary.total_items).toBe(2);
		expect(summary.items).toHaveLength(1);
		expect(summary.items[0]).toMatchObject({ severity: "error", line: 1, column: 1 });
		expect(JSON.stringify(summary)).not.toContain("i1");
	});

	it("按 source+URI 分区，不同 source baseline 标记 unknown", () => {
		const ledger = new DiagnosticsLedger();
		ledger.update(source, uri, [diag(DiagnosticSeverity.Warning, 1, 1, "one")], "warning", 2);
		ledger.update(otherSource, uri, [diag(DiagnosticSeverity.Error, 2, 1, "two")], "warning", 7);

		const first = ledger.snapshot(source, uri);
		const second = ledger.snapshot(otherSource, uri);
		expect(first).toMatchObject({ source, version: 2, items: [{ message: "one" }] });
		expect(second).toMatchObject({ source: otherSource, version: 7, items: [{ message: "two" }] });
		expect(summarizeDiagnostics(second, first, 10)).toMatchObject({
			baseline: "unknown",
			new_errors: 1,
		});
	});

	it("同毫秒连续 update 仍产生不同单调 revision", () => {
		vi.spyOn(Date, "now").mockReturnValue(1234);
		const ledger = new DiagnosticsLedger();
		const first = ledger.update(source, uri, [], "warning");
		const second = ledger.update(source, uri, [], "warning");
		expect(first.updatedAt).toBe(1234);
		expect(second.updatedAt).toBe(1234);
		expect(second.revision).toBeGreaterThan(first.revision);
	});

	it("旧快照没有新 revision 时 deadline 返回 timeout 信号", async () => {
		vi.useFakeTimers();
		const ledger = new DiagnosticsLedger();
		const old = ledger.update(source, uri, [], "warning");
		const waiting = ledger.waitForNewer(source, uri, old.revision, 100, 10);
		await vi.advanceTimersByTimeAsync(100);
		await expect(waiting).resolves.toBeUndefined();
	});

	it("wait 前已到达的 update 直接进入 settle", async () => {
		vi.useFakeTimers();
		const ledger = new DiagnosticsLedger();
		const captured = ledger.revision(source, uri);
		const updated = ledger.update(source, uri, [diag(DiagnosticSeverity.Warning, 1, 1, "ready")], "warning");
		const waiting = ledger.waitForNewer(source, uri, captured, 1000, 50);
		await vi.advanceTimersByTimeAsync(50);
		await expect(waiting).resolves.toMatchObject({ revision: updated.revision, items: [{ message: "ready" }] });
	});

	it("每次新 diagnostics 重置 settle timer", async () => {
		vi.useFakeTimers();
		const ledger = new DiagnosticsLedger();
		const captured = ledger.revision(source, uri);
		const waiting = ledger.waitForNewer(source, uri, captured, 1000, 50);
		ledger.update(source, uri, [diag(DiagnosticSeverity.Warning, 1, 1, "first")], "warning");
		await vi.advanceTimersByTimeAsync(40);
		const latest = ledger.update(source, uri, [diag(DiagnosticSeverity.Warning, 1, 1, "latest")], "warning");
		await vi.advanceTimersByTimeAsync(49);
		let settled = false;
		void waiting.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(waiting).resolves.toMatchObject({ revision: latest.revision, items: [{ message: "latest" }] });
	});

	it("max_wait=0 不 sleep，仅接收已经到达的新 revision", async () => {
		vi.useFakeTimers();
		const ledger = new DiagnosticsLedger();
		const captured = ledger.revision(source, uri);
		await expect(ledger.waitForNewer(source, uri, captured, 0, 500)).resolves.toBeUndefined();
		const updated = ledger.update(source, uri, [], "warning");
		await expect(ledger.waitForNewer(source, uri, captured, 0, 500)).resolves.toMatchObject({ revision: updated.revision });
		expect(vi.getTimerCount()).toBe(0);
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

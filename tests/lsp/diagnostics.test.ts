import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";

import { DiagnosticsLedger, summarizeDiagnostics } from "../../src/lsp/diagnostics/ledger.js";

const source = "/repo\0ts";
const otherSource = "/other\0ts";
const uri = pathToFileURL("repo/a.ts").toString();

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

	it("诊断仅因行号移动时不算新增或已解决", () => {
		const ledger = new DiagnosticsLedger();
		ledger.update(source, uri, [diag(DiagnosticSeverity.Error, 10, 1, "same error")], "warning");
		const before = ledger.snapshot(source, uri);
		ledger.update(source, uri, [diag(DiagnosticSeverity.Error, 11, 1, "same error")], "warning");

		expect(summarizeDiagnostics(ledger.snapshot(source, uri), before, 10)).toMatchObject({
			file_errors: 1,
			new_errors: 0,
			resolved_errors: 0,
		});
	});

	it("诊断身份包含 source 并按重复数量计算", () => {
		const ledger = new DiagnosticsLedger();
		ledger.update(source, uri, [
			diag(DiagnosticSeverity.Error, 1, 1, "same", "eslint"),
			diag(DiagnosticSeverity.Error, 2, 1, "duplicate"),
			diag(DiagnosticSeverity.Error, 3, 1, "duplicate"),
		], "warning");
		const before = ledger.snapshot(source, uri);
		ledger.update(source, uri, [
			diag(DiagnosticSeverity.Error, 4, 1, "same", "typescript"),
			diag(DiagnosticSeverity.Error, 5, 1, "duplicate"),
		], "warning");

		expect(summarizeDiagnostics(ledger.snapshot(source, uri), before, 10)).toMatchObject({
			new_errors: 1,
			resolved_errors: 2,
		});
	});

	it("severity 改变仍计为旧级别已解决和新级别新增", () => {
		const ledger = new DiagnosticsLedger();
		ledger.update(source, uri, [diag(DiagnosticSeverity.Warning, 1, 1, "same")], "warning");
		const before = ledger.snapshot(source, uri);
		ledger.update(source, uri, [diag(DiagnosticSeverity.Error, 1, 1, "same")], "warning");

		expect(summarizeDiagnostics(ledger.snapshot(source, uri), before, 10)).toMatchObject({
			new_errors: 1,
			resolved_warnings: 1,
		});
	});

	it("edit 只选择可归因的新诊断，并按严重级别优先截断", () => {
		const ledger = new DiagnosticsLedger();
		ledger.update(source, uri, [
			diag(DiagnosticSeverity.Error, 2, 1, "old error"),
			diag(DiagnosticSeverity.Warning, 3, 1, "old warning"),
		], "warning");
		const before = ledger.snapshot(source, uri);
		ledger.update(source, uri, [
			diag(DiagnosticSeverity.Error, 2, 1, "old error"),
			diag(DiagnosticSeverity.Warning, 3, 1, "old warning"),
			diag(DiagnosticSeverity.Error, 20, 1, "new error"),
			diag(DiagnosticSeverity.Warning, 5, 1, "new warning in change"),
			diag(DiagnosticSeverity.Warning, 30, 1, "new warning outside change"),
		], "warning");

		expect(summarizeDiagnostics(ledger.snapshot(source, uri), before, 2, undefined, {
			changedRanges: [{ startLine: 5, endLine: 5 }],
		})).toMatchObject({
			baseline: "known",
			items: [
				{ severity: "error", line: 20, message: "new error" },
				{ severity: "warning", line: 5, message: "new warning in change" },
			],
			total_items: 2,
		});
	});

	it("baseline 未知时只选择修改范围或所属符号内的 error", () => {
		const ledger = new DiagnosticsLedger();
		ledger.update(source, uri, [
			diag(DiagnosticSeverity.Error, 4, 1, "inside symbol"),
			diag(DiagnosticSeverity.Error, 20, 1, "outside symbol"),
			diag(DiagnosticSeverity.Warning, 5, 1, "warning"),
		], "warning");

		expect(summarizeDiagnostics(ledger.snapshot(source, uri), undefined, 8, undefined, {
			changedRanges: [{ startLine: 5, endLine: 5 }],
			symbolRanges: [{ startLine: 1, endLine: 10 }],
		})).toMatchObject({
			baseline: "unknown",
			items: [{ severity: "error", line: 4, message: "inside symbol" }],
			total_items: 1,
		});
	});

	it("按配置限制 related locations 并保留 workspace 相对位置", () => {
		const ledger = new DiagnosticsLedger();
		const relatedDiagnostic = diag(DiagnosticSeverity.Error, 1, 1, "conflict");
		relatedDiagnostic.relatedInformation = [
			{
				location: {
					uri: pathToFileURL("/repo/first.ts").toString(),
					range: { start: { line: 4, character: 2 }, end: { line: 4, character: 3 } },
				},
				message: "first declaration",
			},
			{
				location: {
					uri: pathToFileURL("/repo/second.ts").toString(),
					range: { start: { line: 6, character: 1 }, end: { line: 6, character: 2 } },
				},
				message: "second declaration",
			},
		];

		ledger.update(source, uri, [relatedDiagnostic], "warning", undefined, 1);
		expect(ledger.snapshot(source, uri).items[0]?.message).toBe(
			"conflict [related: first.ts:5:3 first declaration]",
		);
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
		if (first.known !== true || second.known !== true) throw new Error("ledger update must create a known snapshot");
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

function diag(severity: DiagnosticSeverity, line: number, column: number, message: string, diagnosticSource = "test"): Diagnostic {
	return {
		severity,
		range: {
			start: { line: line - 1, character: column - 1 },
			end: { line: line - 1, character: column },
		},
		message,
		source: diagnosticSource,
	};
}

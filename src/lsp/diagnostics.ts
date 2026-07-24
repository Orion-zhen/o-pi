import path from "node:path";
import type { Diagnostic } from "vscode-languageserver-protocol";
import { DiagnosticSeverity } from "vscode-languageserver-protocol";

import type { LspDiagnosticItem, LspDiagnosticSnapshot, LspDiagnosticsSummary, LspSeverityName } from "./types.js";

const severityOrder: Record<LspSeverityName, number> = {
	error: 1,
	warning: 2,
	information: 3,
	hint: 4,
};

type DiagnosticsListener = (snapshot: LspDiagnosticSnapshot) => void;

/** 保存按 client source+URI 分区的诊断快照，并提供事件驱动等待和 compact diff。 */
export class DiagnosticsLedger {
	private readonly entries = new Map<string, LspDiagnosticSnapshot>();
	private readonly listeners = new Map<string, Set<DiagnosticsListener>>();
	private nextRevision = 0;

	update(
		source: string,
		uri: string,
		diagnostics: readonly Diagnostic[],
		minSeverity: LspSeverityName,
		version?: number,
	): LspDiagnosticSnapshot {
		this.nextRevision += 1;
		const snapshot: LspDiagnosticSnapshot = {
			source,
			uri,
			items: diagnostics.map(toItem).filter((item) => severityOrder[item.severity] <= severityOrder[minSeverity]),
			known: true,
			revision: this.nextRevision,
			updatedAt: Date.now(),
			...(version !== undefined ? { version } : {}),
		};
		const key = entryKey(source, uri);
		this.entries.set(key, snapshot);
		for (const listener of this.listeners.get(key) ?? []) listener(cloneSnapshot(snapshot));
		return cloneSnapshot(snapshot);
	}

	clear(): void {
		this.entries.clear();
		this.listeners.clear();
		this.nextRevision = 0;
	}

	snapshot(source: string, uri: string): LspDiagnosticSnapshot {
		const snapshot = this.entries.get(entryKey(source, uri));
		return snapshot === undefined
			? { source, uri, items: [], known: false, revision: 0 }
			: cloneSnapshot(snapshot);
	}

	revision(source: string, uri: string): number {
		return this.entries.get(entryKey(source, uri))?.revision ?? 0;
	}

	all(): LspDiagnosticSnapshot[] {
		return Array.from(this.entries.values(), cloneSnapshot);
	}

	waitForNewer(
		source: string,
		uri: string,
		afterRevision: number,
		maxWaitMs: number,
		settleMs: number,
	): Promise<LspDiagnosticSnapshot | undefined> {
		const current = this.snapshot(source, uri);
		if (maxWaitMs <= 0) return Promise.resolve(current.revision > afterRevision ? current : undefined);

		return new Promise((resolve) => {
			let finished = false;
			let settleTimer: NodeJS.Timeout | undefined;
			let deadlineTimer: NodeJS.Timeout | undefined;
			let unsubscribe = (): void => undefined;

			const finish = (snapshot: LspDiagnosticSnapshot | undefined): void => {
				if (finished) return;
				finished = true;
				if (settleTimer !== undefined) clearTimeout(settleTimer);
				if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
				unsubscribe();
				resolve(snapshot);
			};
			const scheduleSettle = (snapshot: LspDiagnosticSnapshot): void => {
				if (snapshot.revision <= afterRevision) return;
				if (settleTimer !== undefined) clearTimeout(settleTimer);
				const elapsed = snapshot.updatedAt === undefined ? 0 : Math.max(0, Date.now() - snapshot.updatedAt);
				const remaining = Math.max(0, settleMs - elapsed);
				if (remaining === 0) {
					finish(snapshot);
					return;
				}
				settleTimer = setTimeout(() => finish(this.snapshot(source, uri)), remaining);
			};

			unsubscribe = this.subscribe(source, uri, scheduleSettle);
			deadlineTimer = setTimeout(() => finish(undefined), maxWaitMs);
			scheduleSettle(current);
		});
	}

	private subscribe(source: string, uri: string, listener: DiagnosticsListener): () => void {
		const key = entryKey(source, uri);
		let listeners = this.listeners.get(key);
		if (listeners === undefined) {
			listeners = new Set();
			this.listeners.set(key, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners?.delete(listener);
			if (listeners?.size === 0) this.listeners.delete(key);
		};
	}
}

export function diagnosticSourceKey(root: string, serverId: string): string {
	return `${path.resolve(root)}\0${serverId}`;
}

export function summarizeDiagnostics(
	after: LspDiagnosticSnapshot,
	baseline: LspDiagnosticSnapshot | undefined,
	maxItems: number,
	overrideStatus?: "unavailable" | "timeout",
): LspDiagnosticsSummary {
	const baselineKnown = baseline?.known === true && baseline.source === after.source && baseline.uri === after.uri;
	if (overrideStatus !== undefined) return emptySummary(overrideStatus, baselineKnown ? "known" : "unknown");
	const beforeItems = baselineKnown ? baseline.items : [];
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
		total_items: after.items.length,
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
		total_items: 0,
		items: [],
	};
}

export function severityName(value: DiagnosticSeverity | undefined): LspSeverityName {
	if (value === DiagnosticSeverity.Error) return "error";
	if (value === DiagnosticSeverity.Warning) return "warning";
	if (value === DiagnosticSeverity.Information) return "information";
	return "hint";
}

function cloneSnapshot(snapshot: LspDiagnosticSnapshot): LspDiagnosticSnapshot {
	return { ...snapshot, items: snapshot.items.map((item) => ({ ...item })) };
}

function entryKey(source: string, uri: string): string {
	return `${source}\0${uri}`;
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

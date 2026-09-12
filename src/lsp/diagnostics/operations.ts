import path from "node:path";

import { relatedDiagnostics } from "./related.js";
import type { LspClient } from "../client/client.js";
import {
	diagnosticSourceKey,
	emptySummary,
	summarizeDiagnostics,
	type DiagnosticSelection,
} from "./ledger.js";
import type { LspManagerRuntime } from "../manager/runtime.js";
import type {
	LspDiagnosticSnapshot,
	LspMutationBaseline,
	LspDiagnosticsSummary,
	LspErrorDiagnostic,
	LspLineRange,
} from "../types.js";
import { fileUriToPath, pathToFileUri, workspaceRelativePath } from "../protocol/uri.js";

export interface LspWriteInput {
	readonly root: string;
	readonly filePath: string;
	readonly text: string;
	readonly changed_ranges?: readonly LspLineRange[];
	readonly baseline?: LspMutationBaseline;
}

export async function beforeDiagnostics(
	context: LspManagerRuntime,
	root: string,
	filePath: string,
): Promise<LspMutationBaseline | undefined> {
	const workspace = await context.workspace(root);
	if (workspace === undefined || !workspace.config.diagnostics.enabled) return undefined;
	const source = workspace.sourceForFile(filePath);
	if (source === undefined) return undefined;
	return {
		...context.diagnostics.snapshot(source, pathToFileUri(filePath)),
		related: context.diagnostics.recent(source, 32),
	};
}

export async function didWriteBatch(
	context: LspManagerRuntime,
	writes: readonly LspWriteInput[],
): Promise<readonly (LspDiagnosticsSummary | undefined)[]> {
	return context.withClientOperation(async () => {
		const results: Array<LspDiagnosticsSummary | undefined> = writes.map(() => undefined);
		const pending = await Promise.all(writes.map(async (write, index) => {
			const workspace = await context.workspace(write.root);
			if (workspace === undefined || !workspace.config.diagnostics.enabled) return undefined;
			const config = workspace.config;
			const route = workspace.routeForFile(write.filePath);
			const expectedSource = route === undefined ? undefined : diagnosticSourceKey(workspace.root, route.server.id);
			const uri = pathToFileUri(write.filePath);
			const client = route === undefined ? undefined : await workspace.client(route.server);
			if (client === undefined) {
				results[index] = emptySummary("unavailable", baselineState(write.baseline, expectedSource, uri));
				return undefined;
			}
			const source = client.diagnosticSource();
			return {
				index,
				write,
				config,
				workspace,
				client,
				source,
				uri,
				capturedRevision: context.diagnostics.revision(source, uri),
			};
		}));

		type PendingWrite = NonNullable<(typeof pending)[number]>;
		const byClient = new Map<LspClient, [PendingWrite, ...PendingWrite[]]>();
		for (const item of pending) {
			if (item === undefined) continue;
			const group = byClient.get(item.client);
			if (group === undefined) byClient.set(item.client, [item]);
			else group.push(item);
		}

		await Promise.all(Array.from(byClient, async ([client, grouped]) => {
			const diagnosticsConfig = grouped[0].config.diagnostics;
			const collected = await client.saveAndCollectDiagnosticsBatch(
				grouped.map(({ write }) => ({ filePath: write.filePath, text: write.text })),
				{ timeoutMs: Math.max(1, diagnosticsConfig.max_wait_ms) },
			);
			const summaries = await Promise.all(grouped.map(async (item, groupIndex) => {
				const value = collected[groupIndex];
				const selection: DiagnosticSelection | undefined = item.write.changed_ranges === undefined
					? undefined
					: { changedRanges: item.write.changed_ranges.map((range) => ({ startLine: range.start_line, endLine: range.end_line })) };
				let summary: LspDiagnosticsSummary;
				if (value === undefined || value.kind === "unavailable") {
					summary = emptySummary("unavailable", baselineState(item.write.baseline, item.source, item.uri));
				} else if (value.kind === "pull") {
					const current = context.diagnostics.snapshot(item.source, item.uri);
					const snapshot = value.snapshot ?? (current.revision > item.capturedRevision ? current : undefined);
					summary = snapshot === undefined
						? summarizeDiagnostics(current, item.write.baseline, diagnosticsConfig.max_items, "timeout", selection)
						: summarizeDiagnostics(snapshot, item.write.baseline, diagnosticsConfig.max_items, undefined, selection);
				} else {
					const snapshot = await context.diagnostics.waitForNewer(
						item.source,
						item.uri,
						item.capturedRevision,
						Math.min(diagnosticsConfig.max_wait_ms, value.waitMs),
						diagnosticsConfig.settle_ms,
					);
					summary = snapshot === undefined
						? summarizeDiagnostics(context.diagnostics.snapshot(item.source, item.uri), item.write.baseline, diagnosticsConfig.max_items, "timeout", selection)
						: summarizeDiagnostics(snapshot, item.write.baseline, diagnosticsConfig.max_items, undefined, selection);
				}
				return { item, value, summary };
			}));
			const excluded = new Set(grouped.map((item) => item.uri));
			for (const { item, value, summary } of summaries) {
				results[item.index] = summary;
				if (value?.kind !== "pull" || summary.status === "timeout") continue;
				const related = relatedDiagnostics(
					item.workspace,
					(value.related ?? []).filter((report) => context.diagnostics.revision(report.source, report.uri) === report.revision),
					item.write.baseline?.related ?? [],
					excluded,
					diagnosticsConfig.max_items - summary.items.length,
				);
				if (related.length > 0) summary.related = related;
			}
			const hintDeadline = Date.now() + Math.min(300, diagnosticsConfig.max_wait_ms);
			for (const { item, summary } of summaries) {
				const timeoutMs = hintDeadline - Date.now();
				if (timeoutMs <= 0) break;
				const eligible = summary.items.filter((diagnostic): diagnostic is LspErrorDiagnostic => diagnostic.severity === "error" && diagnostic.change !== "existing");
				if (eligible.length === 0) continue;
				// 提示是独立增强，失败不能丢弃已经取得的诊断。
				const hints = await client.diagnosticHints(item.write.filePath, item.write.text, eligible, { timeoutMs }).catch(() => []);
				for (const [index, diagnostic] of eligible.entries()) {
					const hint = hints[index];
					if (hint !== undefined) diagnostic.hint = hint;
				}
			}
		}));
		return results;
	});
}

export async function knownDiagnostics(
	context: LspManagerRuntime,
	root: string,
	filePath?: string,
): Promise<Array<{ path: string; items: LspDiagnosticsSummary["items"] }>> {
	const normalizedRoot = path.resolve(root);
	const workspace = await context.workspace(normalizedRoot);
	if (workspace === undefined) return [];
	const registryServers = new Map(workspace.config.servers.map((server) => [diagnosticSourceKey(normalizedRoot, server.id), server]));
	const entries = context.diagnostics.all();
	return entries.flatMap((entry) => {
		const server = registryServers.get(entry.source);
		if (server === undefined) return [];
		const absolute = uriToWorkspacePath(normalizedRoot, entry.uri);
		if (absolute === undefined || workspace.route(absolute.relative)?.server.id !== server.id) return [];
		if (filePath !== undefined && absolute.path !== filePath && absolute.relative !== filePath) return [];
		return [{ path: absolute.relative, items: entry.items }];
	});
}

function baselineState(baseline: LspDiagnosticSnapshot | undefined, source: string | undefined, uri: string): "known" | "unknown" {
	return baseline?.known === true && source !== undefined && baseline.source === source && baseline.uri === uri ? "known" : "unknown";
}

function uriToWorkspacePath(root: string, uri: string): { path: string; relative: string } | undefined {
	const absolute = fileUriToPath(uri);
	if (absolute === undefined) return undefined;
	const relative = workspaceRelativePath(root, absolute);
	if (relative === undefined) return undefined;
	return { path: absolute, relative };
}

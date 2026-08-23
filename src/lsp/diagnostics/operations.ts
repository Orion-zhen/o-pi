import path from "node:path";

import { LspClient } from "../client/client.js";
import {
	diagnosticSourceKey,
	emptySummary,
	summarizeDiagnostics,
	DiagnosticsLedger,
	type DiagnosticSelection,
} from "./ledger.js";
import { isExcludedRoot } from "../manager/runtime.js";
import { modifiedSymbolRanges } from "../analysis/symbols.js";
import type {
	LoadedLspConfig,
	LspDiagnosticSnapshot,
	LspDiagnosticsSummary,
	LspLineRange,
	LspServerConfig,
} from "../types.js";
import { fileUriToPath, pathToFileUri, workspaceRelativePath } from "../protocol/uri.js";

export interface LspWriteInput {
	readonly root: string;
	readonly filePath: string;
	readonly text: string;
	readonly changed_ranges?: readonly LspLineRange[];
	readonly baseline?: LspDiagnosticSnapshot;
}

export interface LspDiagnosticsContext {
	readonly diagnostics: DiagnosticsLedger;
	enabledConfig(root: string): Promise<LoadedLspConfig | undefined>;
	ensureConfig(root: string): Promise<LoadedLspConfig | undefined>;
	withClientOperation<T>(operation: () => Promise<T>): Promise<T>;
	clientForFile(root: string, filePath: string): Promise<LspClient | undefined>;
	diagnosticSourceForFile(root: string, filePath: string): string | undefined;
	serversForRoot(root: string): readonly LspServerConfig[];
	serverOwnsPath(root: string, server: LspServerConfig, relativePath: string): boolean;
}

export async function beforeDiagnostics(
	context: LspDiagnosticsContext,
	root: string,
	filePath: string,
): Promise<LspDiagnosticSnapshot | undefined> {
	const config = await context.enabledConfig(root);
	if (config === undefined || isExcludedRoot(root, config.config.exclude_paths) || !config.config.diagnostics.enabled) return undefined;
	const source = context.diagnosticSourceForFile(root, filePath);
	if (source === undefined) return undefined;
	return context.diagnostics.snapshot(source, pathToFileUri(filePath));
}

export async function didWriteBatch(
	context: LspDiagnosticsContext,
	writes: readonly LspWriteInput[],
): Promise<readonly (LspDiagnosticsSummary | undefined)[]> {
	return context.withClientOperation(async () => {
		const results: Array<LspDiagnosticsSummary | undefined> = writes.map(() => undefined);
		const pending = await Promise.all(writes.map(async (write, index) => {
			const config = await context.enabledConfig(write.root);
			if (config === undefined || isExcludedRoot(write.root, config.config.exclude_paths) || !config.config.diagnostics.enabled) return undefined;
			const expectedSource = context.diagnosticSourceForFile(write.root, write.filePath);
			const uri = pathToFileUri(write.filePath);
			const client = await context.clientForFile(write.root, write.filePath);
			if (client === undefined) {
				results[index] = emptySummary("unavailable", baselineState(write.baseline, expectedSource, uri));
				return undefined;
			}
			const source = client.diagnosticSource();
			return {
				index,
				write,
				config,
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
			const diagnosticsConfig = grouped[0].config.config.diagnostics;
			const selections = await Promise.all(grouped.map((item) => createEditSelection(item.client, item.write, item.source, item.uri)));
			const collected = await client.saveAndCollectDiagnosticsBatch(
				grouped.map(({ write }) => ({ filePath: write.filePath, text: write.text })),
				{ timeoutMs: Math.max(1, diagnosticsConfig.max_wait_ms) },
			);
			await Promise.all(grouped.map(async (item, groupIndex) => {
				const value = collected[groupIndex];
				if (value === undefined || value.kind === "unavailable") {
					results[item.index] = emptySummary("unavailable", baselineState(item.write.baseline, item.source, item.uri));
					return;
				}
				if (value.kind === "pull") {
					const current = context.diagnostics.snapshot(item.source, item.uri);
					const snapshot = value.snapshot ?? (current.revision > item.capturedRevision ? current : undefined);
					results[item.index] = snapshot === undefined
						? summarizeDiagnostics(current, item.write.baseline, diagnosticsConfig.max_items, "timeout", selections[groupIndex])
						: summarizeDiagnostics(snapshot, item.write.baseline, diagnosticsConfig.max_items, undefined, selections[groupIndex]);
					return;
				}
				const snapshot = await context.diagnostics.waitForNewer(
					item.source,
					item.uri,
					item.capturedRevision,
					Math.min(diagnosticsConfig.max_wait_ms, value.waitMs),
					diagnosticsConfig.settle_ms,
				);
				results[item.index] = snapshot === undefined
					? summarizeDiagnostics(context.diagnostics.snapshot(item.source, item.uri), item.write.baseline, diagnosticsConfig.max_items, "timeout", selections[groupIndex])
					: summarizeDiagnostics(snapshot, item.write.baseline, diagnosticsConfig.max_items, undefined, selections[groupIndex]);
			}));
		}));
		return results;
	});
}

export async function knownDiagnostics(
	context: LspDiagnosticsContext,
	root: string,
	filePath?: string,
): Promise<Array<{ path: string; items: LspDiagnosticsSummary["items"] }>> {
	const normalizedRoot = path.resolve(root);
	await context.ensureConfig(normalizedRoot);
	const registryServers = new Map(context.serversForRoot(normalizedRoot).map((server) => [diagnosticSourceKey(normalizedRoot, server.id), server]));
	const entries = context.diagnostics.all();
	return entries.flatMap((entry) => {
		const server = registryServers.get(entry.source);
		if (server === undefined) return [];
		const absolute = uriToWorkspacePath(normalizedRoot, entry.uri);
		if (absolute === undefined || !context.serverOwnsPath(normalizedRoot, server, absolute.relative)) return [];
		if (filePath !== undefined && absolute.path !== filePath && absolute.relative !== filePath) return [];
		return [{ path: absolute.relative, items: entry.items }];
	});
}

async function createEditSelection(
	client: LspClient,
	write: LspWriteInput,
	source: string,
	uri: string,
): Promise<DiagnosticSelection | undefined> {
	if (write.changed_ranges === undefined) return undefined;
	const changedRanges = write.changed_ranges.map((range) => ({
		startLine: range.start_line,
		endLine: range.end_line,
	}));
	if (baselineState(write.baseline, source, uri) === "known") return { changedRanges };
	try {
		const symbols = await client.documentSymbols(write.filePath, write.text);
		return {
			changedRanges,
			symbolRanges: modifiedSymbolRanges(symbols, changedRanges).map((range) => ({ startLine: range.line, endLine: range.end_line })),
		};
	} catch {
		return { changedRanges };
	}
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

import path from "node:path";
import pLimit from "p-limit";
import type { FileChangeType, WorkspaceSymbol } from "vscode-languageserver-protocol";

import { LspClient } from "./client.js";
import { LspServerRegistry } from "./registry.js";
import { loadLspConfig, normalizeExcludePath, resolveLspConfigPath } from "./config.js";
import { diagnosticSourceKey, DiagnosticsLedger, emptySummary, summarizeDiagnostics, type DiagnosticSelection } from "./diagnostics.js";
import {
	findEnclosingSymbol,
	modifiedSymbolRanges,
	remainingSymbols,
	hasUriOnlyWorkspaceSymbolLocation,
	referenceHits,
	workspaceSymbolLocation,
	workspaceSymbolSeed,
	type ReferenceHit,
	type WorkspaceSymbolSeed,
} from "./symbols.js";
import { fileUriToPath, pathToFileUri, workspaceRelativePath } from "./uri.js";
import type {
	LoadedLspConfig,
	LspDiagnosticSnapshot,
	LspDiagnosticsSummary,
	LspLineRange,
	LspEnclosingSymbol,
	LspFileRoute,
	LspRemainingSymbol,
	LspServerConfig,
	LspStatus,
	LspSymbolHit,
} from "./types.js";

const RESOLVE_CONCURRENCY = 4;
const REFERENCE_CONCURRENCY = 4;

interface ClientEntry {
	client: LspClient;
	restarts: number;
	restartPromise?: Promise<LspClient | undefined>;
}

type SymbolCandidate =
	| { kind: "complete"; client: LspClient; seed: WorkspaceSymbolSeed }
	| { kind: "resolve"; client: LspClient; symbol: WorkspaceSymbol };

interface AcceptedSymbol {
	client: LspClient;
	seed: WorkspaceSymbolSeed;
}

interface OperationDeadline {
	signal: AbortSignal;
	requestOptions(): { signal: AbortSignal; timeoutMs: number };
	dispose(): void;
}

export interface WorkspaceSymbolsInput {
	root: string;
	query: string;
	allowedPaths: ReadonlySet<string>;
	/** 仅显式关系查询允许继续请求 references。 */
	relationQuery?: boolean;
	signal?: AbortSignal;
}

export interface ReadEnhancement {
	/** 整文件截断且可见部分不足以覆盖顶层结构时的导航回退。 */
	remaining_symbols?: LspRemainingSymbol[];
	/** partial range 所属的最小包围 symbol。 */
	enclosing_symbol?: LspEnclosingSymbol;
}

/** 进程内 LSP 管理器：负责配置、server 选择、生命周期和 diagnostics ledger。 */
export class LspManager {
	private readonly loaded = new Map<string, LoadedLspConfig>();
	private readonly registries = new Map<string, LspServerRegistry>();
	private readonly configErrors = new Map<string, string>();
	private reloadPromise: Promise<void> | undefined;
	private reloadRequested = false;
	private activeClientOperations = 0;
	private clientDrainResolve: (() => void) | undefined;
	private readonly clients = new Map<string, ClientEntry>();
	private readonly diagnostics = new DiagnosticsLedger();

	async status(root = process.cwd()): Promise<LspStatus> {
		const normalizedRoot = path.resolve(root);
		await this.ensureConfig(normalizedRoot);
		const loaded = this.loaded.get(normalizedRoot);
		const error = this.configErrors.get(normalizedRoot);
		const excluded = loaded !== undefined && isExcludedRoot(normalizedRoot, loaded.config.exclude_paths);
		return {
			enabled: (loaded?.config.enabled ?? false) && !excluded,
			config_path: loaded?.path ?? resolveLspConfigPath(),
			...(error !== undefined ? { last_error: error } : {}),
			servers: Array.from(this.clients.values())
				.filter((entry) => entry.client.root === normalizedRoot)
				.map((entry) => entry.client.status()),
		};
	}

	async reload(): Promise<void> {
		if (this.reloadPromise !== undefined) return this.reloadPromise;
		this.reloadRequested = true;
		const pending = this.performReload();
		this.reloadPromise = pending;
		try {
			await pending;
		} finally {
			if (this.reloadPromise === pending) {
				this.reloadPromise = undefined;
				this.reloadRequested = false;
			}
		}
	}

	private async performReload(): Promise<void> {
		if (this.activeClientOperations > 0) {
			await new Promise<void>((resolve) => {
				this.clientDrainResolve = resolve;
			});
		}
		await Promise.allSettled(Array.from(this.clients.values()).map((entry) => entry.client.shutdown()));
		this.clients.clear();
		this.diagnostics.clear();
		this.loaded.clear();
		this.registries.clear();
		this.configErrors.clear();
	}

	async readEnhancement(root: string, filePath: string, text: string, range: { startLine: number; endLine: number }, options: { outline: boolean; enclosing: boolean }): Promise<ReadEnhancement | undefined> {
		return this.withClientOperation(() => this.readEnhancementOperation(root, filePath, text, range, options));
	}

	private async readEnhancementOperation(root: string, filePath: string, text: string, range: { startLine: number; endLine: number }, options: { outline: boolean; enclosing: boolean }): Promise<ReadEnhancement | undefined> {
		const config = await this.enabledConfig(root);
		if (config === undefined || isExcludedRoot(root, config.config.exclude_paths)) return undefined;
		const wantsOutline = options.outline
			&& !options.enclosing
			&& config.config.read.outline
			&& config.config.read.max_symbols > 0;
		if (!wantsOutline && !options.enclosing) return undefined;
		const client = await this.clientForFile(root, filePath);
		if (client === undefined) return undefined;
		const symbols = await client.documentSymbols(filePath, text);
		if (symbols === undefined) return undefined;
		const result: ReadEnhancement = {};
		if (wantsOutline) {
			const remaining = remainingSymbols(symbols, range.startLine, range.endLine, config.config.read.max_symbols);
			if (remaining.length > 0) result.remaining_symbols = remaining;
		}
		if (options.enclosing) {
			const enclosing = findEnclosingSymbol(symbols, range.startLine, range.endLine);
			if (enclosing !== undefined) result.enclosing_symbol = enclosing;
		}
		return Object.keys(result).length === 0 ? undefined : result;
	}

	async workspaceSymbols(input: WorkspaceSymbolsInput): Promise<LspSymbolHit[]> {
		return this.withClientOperation(() => this.workspaceSymbolsOperation(input));
	}

	private async workspaceSymbolsOperation(input: WorkspaceSymbolsInput): Promise<LspSymbolHit[]> {
		const config = await this.enabledConfig(input.root);
		if (
			config === undefined
			|| isExcludedRoot(input.root, config.config.exclude_paths)
			|| !config.config.grep.workspace_symbols
			|| config.config.grep.max_symbols <= 0
			|| input.allowedPaths.size === 0
		) return [];
		const servers = this.serversForPaths(input.root, input.allowedPaths);
		if (servers.length === 0) return [];

		const allowedPaths = new Set(input.allowedPaths);
		const operation = createOperationDeadline(input.signal, config.config.request_timeout_ms);
		try {
			const serverResults = await Promise.all(servers.map(async (server) => {
				if (operation.signal.aborted) return undefined;
				const client = await waitUnlessAborted(this.clientForServer(input.root, server), operation.signal);
				if (client === undefined || operation.signal.aborted) return undefined;
				const symbols = await client.workspaceSymbols(input.query, operation.requestOptions());
				return symbols === undefined ? undefined : { client, symbols };
			}));

			if (operation.signal.aborted) return [];
			const candidates: SymbolCandidate[] = [];
			const seenRaw = new Set<string>();
			for (const result of serverResults) {
				if (result === undefined) continue;
				for (const symbol of result.symbols) {
					if (operation.signal.aborted) return [];
					const location = workspaceSymbolLocation(symbol);
					if (location !== undefined) {
						const seed = workspaceSymbolSeed(input.root, input.query, symbol);
						if (seed === undefined || !allowedPaths.has(seed.path) || !this.serverOwnsPath(input.root, result.client.server, seed.path)) continue;
						const key = symbolHitKey(seed);
						if (seenRaw.has(key)) continue;
						seenRaw.add(key);
						candidates.push({ kind: "complete", client: result.client, seed });
						continue;
					}
					if (!hasUriOnlyWorkspaceSymbolLocation(symbol) || typeof symbol.name !== "string" || typeof symbol.kind !== "number") continue;
					const relative = relativePathForUri(input.root, symbol.location.uri);
					if (relative === undefined || !allowedPaths.has(relative) || !this.serverOwnsPath(input.root, result.client.server, relative)) continue;
					const key = unresolvedSymbolKey(symbol);
					if (seenRaw.has(key)) continue;
					seenRaw.add(key);
					candidates.push({ kind: "resolve", client: result.client, symbol });
				}
			}

			candidates.sort((left, right) => symbolCandidatePriority(input.query, left) - symbolCandidatePriority(input.query, right));
			const accepted: AcceptedSymbol[] = [];
			const seenHits = new Set<string>();
			const resolveLimit = pLimit(RESOLVE_CONCURRENCY);
			let exactLeafCount = 0;
			let candidateIndex = 0;
			while (
				accepted.length < config.config.grep.max_symbols
				&& candidateIndex < candidates.length
				&& !operation.signal.aborted
			) {
				const remaining = config.config.grep.max_symbols - accepted.length;
				const batchSize = Math.min(RESOLVE_CONCURRENCY, remaining, candidates.length - candidateIndex);
				const batch = candidates.slice(candidateIndex, candidateIndex + batchSize);
				candidateIndex += batchSize;
				const resolved = await Promise.all(batch.map((candidate) => {
					if (candidate.kind === "complete") return Promise.resolve({ client: candidate.client, seed: candidate.seed });
					return resolveLimit(async () => {
						if (operation.signal.aborted) return undefined;
						const symbol = await candidate.client.resolveWorkspaceSymbol(candidate.symbol, operation.requestOptions());
						if (symbol === undefined || operation.signal.aborted) return undefined;
						const seed = workspaceSymbolSeed(input.root, input.query, symbol);
						return seed === undefined || !allowedPaths.has(seed.path) || !this.serverOwnsPath(input.root, candidate.client.server, seed.path)
							? undefined
							: { client: candidate.client, seed };
					});
				}));
				for (const result of resolved) {
					if (result === undefined) continue;
					const exactLeaf = isExactLeafQuery(input.query, result.seed);
					if (exactLeaf && exactLeafCount >= config.config.grep.max_exact_leaf_symbols) continue;
					const key = symbolHitKey(result.seed);
					if (seenHits.has(key)) continue;
					seenHits.add(key);
					accepted.push(result);
					if (exactLeaf) exactLeafCount += 1;
					if (accepted.length >= config.config.grep.max_symbols) break;
				}
			}

			const symbolHits = accepted.map(({ seed }) => publicSymbolHit(seed));
			if (!input.relationQuery || !config.config.grep.references || config.config.grep.max_references <= 0 || operation.signal.aborted) return symbolHits;
			const references = await this.referenceHits(
				input.root,
				accepted,
				allowedPaths,
				seenHits,
				config.config.grep.max_references,
				operation,
			);
			return [...symbolHits, ...references];
		} finally {
			operation.dispose();
		}
	}

	private async referenceHits(
		root: string,
		accepted: readonly AcceptedSymbol[],
		allowedPaths: ReadonlySet<string>,
		seenHits: Set<string>,
		maxReferences: number,
		operation: OperationDeadline,
	): Promise<LspSymbolHit[]> {
		const hits: LspSymbolHit[] = [];
		const limit = pLimit(REFERENCE_CONCURRENCY);
		let index = 0;
		while (hits.length < maxReferences && index < accepted.length && !operation.signal.aborted) {
			const remaining = maxReferences - hits.length;
			const batchSize = Math.min(REFERENCE_CONCURRENCY, remaining, accepted.length - index);
			const batch = accepted.slice(index, index + batchSize);
			index += batchSize;
			const results = await Promise.all(batch.map(({ client, seed }) => limit(async () => {
				if (operation.signal.aborted) return { client, candidates: [] };
				const locations = await client.references(seed.uri, seed.line, seed.character, operation.requestOptions());
				const candidates = locations === undefined || operation.signal.aborted ? [] : referenceHits(root, seed, locations);
				return { client, candidates };
			})));
			for (const result of results) {
				for (const candidate of result.candidates) {
					if (!allowedPaths.has(candidate.path) || !this.serverOwnsPath(root, result.client.server, candidate.path)) continue;
					const key = symbolHitKey(candidate);
					if (seenHits.has(key)) continue;
					seenHits.add(key);
					hits.push(publicReferenceHit(candidate));
					if (hits.length >= maxReferences) break;
				}
				if (hits.length >= maxReferences) break;
			}
		}
		return hits;
	}

	async beforeDiagnostics(root: string, filePath: string): Promise<LspDiagnosticSnapshot | undefined> {
		const config = await this.enabledConfig(root);
		if (config === undefined || isExcludedRoot(root, config.config.exclude_paths) || !config.config.diagnostics.enabled) return undefined;
		const source = this.diagnosticSourceForFile(root, filePath);
		if (source === undefined) return undefined;
		return this.diagnostics.snapshot(source, pathToFileUri(filePath));
	}

	async didChangeWatchedFile(root: string, filePath: string, type: FileChangeType): Promise<void> {
		await this.didChangeWatchedFiles([{ root, filePath, type }]);
	}

	async didChangeWatchedFiles(
		changes: readonly { root: string; filePath: string; type: FileChangeType }[],
	): Promise<void> {
		return this.withClientOperation(async () => {
			const byRoot = new Map<string, Array<{ filePath: string; type: FileChangeType }>>();
			for (const change of changes) {
				const root = path.resolve(change.root);
				const group = byRoot.get(root);
				const item = { filePath: change.filePath, type: change.type };
				if (group === undefined) byRoot.set(root, [item]);
				else group.push(item);
			}
			await Promise.all(Array.from(byRoot, async ([root, grouped]) => {
				const config = await this.enabledConfig(root);
				if (config === undefined || isExcludedRoot(root, config.config.exclude_paths)) return;
				await Promise.all(Array.from(this.clients.values(), ({ client }) => (
					client.root === root ? client.didChangeWatchedFiles(grouped) : Promise.resolve(false)
				)));
			}));
		});
	}

	async didWrite(
		root: string,
		filePath: string,
		text: string,
		baseline?: LspDiagnosticSnapshot,
		changed_ranges?: readonly LspLineRange[],
	): Promise<LspDiagnosticsSummary | undefined> {
		return (await this.didWriteBatch([{
			root,
			filePath,
			text,
			...(changed_ranges === undefined ? {} : { changed_ranges }),
			...(baseline === undefined ? {} : { baseline }),
		}]))[0];
	}

	async didWriteBatch(
		writes: readonly { root: string; filePath: string; text: string; changed_ranges?: readonly LspLineRange[]; baseline?: LspDiagnosticSnapshot }[],
	): Promise<readonly (LspDiagnosticsSummary | undefined)[]> {
		return this.withClientOperation(async () => {
			const results: Array<LspDiagnosticsSummary | undefined> = writes.map(() => undefined);
			const pending = await Promise.all(writes.map(async (write, index) => {
				const config = await this.enabledConfig(write.root);
				if (config === undefined || isExcludedRoot(write.root, config.config.exclude_paths) || !config.config.diagnostics.enabled) return undefined;
				const expectedSource = this.diagnosticSourceForFile(write.root, write.filePath);
				const uri = pathToFileUri(write.filePath);
				const client = await this.clientForFile(write.root, write.filePath);
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
					capturedRevision: this.diagnostics.revision(source, uri),
				};
			}));

			const byClient = new Map<LspClient, Array<NonNullable<(typeof pending)[number]>>>();
			for (const item of pending) {
				if (item === undefined) continue;
				const group = byClient.get(item.client);
				if (group === undefined) byClient.set(item.client, [item]);
				else group.push(item);
			}

			await Promise.all(Array.from(byClient, async ([client, grouped]) => {
				const diagnosticsConfig = grouped[0]?.config.config.diagnostics;
				if (diagnosticsConfig === undefined) return;
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
						const current = this.diagnostics.snapshot(item.source, item.uri);
						const snapshot = value.snapshot ?? (current.revision > item.capturedRevision ? current : undefined);
						results[item.index] = snapshot === undefined
							? summarizeDiagnostics(current, item.write.baseline, diagnosticsConfig.max_items, "timeout", selections[groupIndex])
							: summarizeDiagnostics(snapshot, item.write.baseline, diagnosticsConfig.max_items, undefined, selections[groupIndex]);
						return;
					}
					const snapshot = await this.diagnostics.waitForNewer(
						item.source,
						item.uri,
						item.capturedRevision,
						Math.min(diagnosticsConfig.max_wait_ms, value.waitMs),
						diagnosticsConfig.settle_ms,
					);
					results[item.index] = snapshot === undefined
						? summarizeDiagnostics(this.diagnostics.snapshot(item.source, item.uri), item.write.baseline, diagnosticsConfig.max_items, "timeout", selections[groupIndex])
						: summarizeDiagnostics(snapshot, item.write.baseline, diagnosticsConfig.max_items, undefined, selections[groupIndex]);
				}));
			}));
			return results;
		});
	}

	async knownDiagnostics(root: string, filePath?: string): Promise<Array<{ path: string; items: LspDiagnosticsSummary["items"] }>> {
		const normalizedRoot = path.resolve(root);
		await this.ensureConfig(normalizedRoot);
		const registry = this.registries.get(normalizedRoot);
		const sourceServers = new Map((registry?.servers ?? []).map((server) => [diagnosticSourceKey(normalizedRoot, server.id), server]));
		const entries = this.diagnostics.all();
		return entries.flatMap((entry) => {
			const server = sourceServers.get(entry.source);
			if (server === undefined) return [];
			const absolute = uriToWorkspacePath(normalizedRoot, entry.uri);
			if (absolute === undefined || !this.serverOwnsPath(normalizedRoot, server, absolute.relative)) return [];
			if (filePath !== undefined && absolute.path !== filePath && absolute.relative !== filePath) return [];
			return [{ path: absolute.relative, items: entry.items }];
		});
	}

	private diagnosticSourceForFile(root: string, filePath: string): string | undefined {
		const route = this.routeForFile(root, filePath);
		return route === undefined ? undefined : diagnosticSourceKey(root, route.server.id);
	}

	private async clientForFile(root: string, filePath: string): Promise<LspClient | undefined> {
		const config = await this.enabledConfig(root);
		if (config === undefined || isExcludedRoot(root, config.config.exclude_paths)) return undefined;
		const route = this.routeForFile(root, filePath);
		return route === undefined ? undefined : this.clientForServer(root, route.server);
	}

	private routeForFile(root: string, filePath: string): LspFileRoute | undefined {
		const relativePath = workspaceRelativePath(root, filePath);
		return relativePath === undefined ? undefined : this.routeForRelativePath(root, relativePath);
	}

	private routeForRelativePath(root: string, relativePath: string): LspFileRoute | undefined {
		const normalizedRoot = path.resolve(root);
		try {
			return this.registries.get(normalizedRoot)?.route(relativePath);
		} catch (error) {
			this.configErrors.set(normalizedRoot, error instanceof Error ? error.message : String(error));
			return undefined;
		}
	}

	private serversForPaths(root: string, paths: Iterable<string>): LspServerConfig[] {
		const normalizedRoot = path.resolve(root);
		try {
			return this.registries.get(normalizedRoot)?.forPaths(paths) ?? [];
		} catch (error) {
			this.configErrors.set(normalizedRoot, error instanceof Error ? error.message : String(error));
			return [];
		}
	}

	private serverOwnsPath(root: string, server: LspServerConfig, relativePath: string): boolean {
		const normalizedRoot = path.resolve(root);
		try {
			return this.registries.get(normalizedRoot)?.ownsPath(server, relativePath) ?? false;
		} catch (error) {
			this.configErrors.set(normalizedRoot, error instanceof Error ? error.message : String(error));
			return false;
		}
	}

	private async clientForServer(root: string, server: LspServerConfig): Promise<LspClient | undefined> {
		const loaded = await this.enabledConfig(root);
		if (loaded === undefined) return undefined;
		const key = diagnosticSourceKey(root, server.id);
		let entry = this.clients.get(key);
		if (entry === undefined) {
			entry = { restarts: 0, client: this.createClient(key, root, server, loaded) };
			this.clients.set(key, entry);
		} else if (entry.client.status().status === "crashed") {
			const restarted = await this.restartClient(key, root, server, loaded, entry);
			if (restarted === undefined) return undefined;
		}
		const client = entry.client;
		const ready = await client.ensureReady();
		return ready ? client : undefined;
	}

	private restartClient(
		key: string,
		root: string,
		server: LspServerConfig,
		loaded: LoadedLspConfig,
		entry: ClientEntry,
	): Promise<LspClient | undefined> {
		if (entry.restartPromise !== undefined) return entry.restartPromise;
		const crashedClient = entry.client;
		const pending = this.performClientRestart(key, root, server, loaded, entry, crashedClient);
		entry.restartPromise = pending;
		void pending.then(
			() => {
				if (entry.restartPromise === pending) delete entry.restartPromise;
			},
			() => {
				if (entry.restartPromise === pending) delete entry.restartPromise;
			},
		);
		return pending;
	}

	private async performClientRestart(
		key: string,
		root: string,
		server: LspServerConfig,
		loaded: LoadedLspConfig,
		entry: ClientEntry,
		crashedClient: LspClient,
	): Promise<LspClient | undefined> {
		await crashedClient.waitForCleanup();
		if (this.clients.get(key) !== entry || entry.client !== crashedClient) return undefined;
		if (entry.restarts >= loaded.config.max_restarts) return undefined;
		entry.restarts += 1;
		const replacement = this.createClient(key, root, server, loaded);
		entry.client = replacement;
		return replacement;
	}

	private async withClientOperation<T>(operation: () => Promise<T>): Promise<T> {
		await this.waitForReload();
		this.activeClientOperations += 1;
		try {
			return await operation();
		} finally {
			this.activeClientOperations -= 1;
			if (this.activeClientOperations === 0) {
				this.clientDrainResolve?.();
				this.clientDrainResolve = undefined;
			}
		}
	}

	private async waitForReload(): Promise<void> {
		while (this.reloadRequested) {
			const pending = this.reloadPromise;
			if (pending === undefined) {
				await Promise.resolve();
				continue;
			}
			await pending;
		}
	}

	private createClient(key: string, root: string, server: LspServerConfig, loaded: LoadedLspConfig): LspClient {
		return new LspClient(path.resolve(root), server, loaded.config, this.diagnostics, (client, message) => {
			this.handleCrash(key, client, message);
		}, () => this.clients.get(key)?.restarts ?? 0);
	}

	private handleCrash(key: string, client: LspClient, message: string): void {
		const entry = this.clients.get(key);
		if (entry === undefined || entry.client !== client) return;
		this.configErrors.set(path.resolve(client.root), message);
	}

	private async enabledConfig(root: string): Promise<LoadedLspConfig | undefined> {
		const loaded = await this.ensureConfig(root);
		if (loaded === undefined || !loaded.config.enabled) return undefined;
		return loaded;
	}

	private async ensureConfig(root: string): Promise<LoadedLspConfig | undefined> {
		const normalizedRoot = path.resolve(root);
		if (this.loaded.has(normalizedRoot) || this.configErrors.has(normalizedRoot)) return this.loaded.get(normalizedRoot);
		try {
			const loaded = await loadLspConfig(normalizedRoot);
			this.loaded.set(normalizedRoot, loaded);
			this.registries.set(normalizedRoot, new LspServerRegistry(loaded.config.servers));
			return loaded;
		} catch (error) {
			this.configErrors.set(normalizedRoot, error instanceof Error ? error.message : String(error));
			return undefined;
		}
	}
}

function isExcludedRoot(root: string, excludePaths: readonly string[]): boolean {
	const normalizedRoot = normalizeExcludePath(root);
	return excludePaths.some((excludePath) => normalizedRoot === normalizeExcludePath(excludePath));
}

function createOperationDeadline(parent: AbortSignal | undefined, timeoutMs: number): OperationDeadline {
	const controller = new AbortController();
	const onAbort = (): void => controller.abort();
	if (parent?.aborted === true) controller.abort();
	else parent?.addEventListener("abort", onAbort, { once: true });
	const deadline = Date.now() + timeoutMs;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref();
	return {
		signal: controller.signal,
		requestOptions: () => ({ signal: controller.signal, timeoutMs: Math.max(1, deadline - Date.now()) }),
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onAbort);
		},
	};
}

function waitUnlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	if (signal.aborted) return Promise.resolve(undefined);
	return new Promise<T | undefined>((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			resolve(undefined);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function relativePathForUri(root: string, uri: string): string | undefined {
	const filePath = fileUriToPath(uri);
	return filePath === undefined ? undefined : workspaceRelativePath(root, filePath);
}

function symbolCandidatePriority(query: string, candidate: SymbolCandidate): number {
	const name = candidate.kind === "complete" ? symbolLeaf(candidate.seed.symbol) : symbolLeaf(candidate.symbol.name);
	const qualified = candidate.kind === "complete"
		? candidate.seed.qualified_symbol === undefined
			? /[.:#]/u.test(candidate.seed.symbol) ? normalizeSymbolText(candidate.seed.symbol) : undefined
			: normalizeSymbolText(candidate.seed.qualified_symbol)
		: "containerName" in candidate.symbol && typeof candidate.symbol.containerName === "string" && candidate.symbol.containerName.length > 0
			? /[.:#]/u.test(candidate.symbol.name)
				? normalizeSymbolText(candidate.symbol.name)
				: normalizeSymbolText(`${candidate.symbol.containerName}.${candidate.symbol.name}`)
			: /[.:#]/u.test(candidate.symbol.name) ? normalizeSymbolText(candidate.symbol.name) : undefined;
	const target = normalizeSymbolText(query);
	if (qualified === target) return 0;
	if (name === target) return 1;
	if (name.startsWith(target)) return 2;
	return 3;
}

function isExactLeafQuery(query: string, seed: WorkspaceSymbolSeed): boolean {
	return !/[.:#]/u.test(query) && symbolLeaf(seed.symbol) === normalizeSymbolText(query);
}

function symbolLeaf(value: string): string {
	return normalizeSymbolText(value).split(".").at(-1) ?? normalizeSymbolText(value);
}

function normalizeSymbolText(value: string): string {
	return value.replace(/::|#/gu, ".").toLocaleLowerCase();
}

function unresolvedSymbolKey(symbol: WorkspaceSymbol): string {
	return [symbol.location.uri, symbol.name, symbol.kind, symbol.containerName ?? "", shallowDataKey(symbol.data)].join("\0");
}

function shallowDataKey(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `array:${value.length}:${value.slice(0, 4).map(shallowPrimitiveKey).join(",")}`;
	if (typeof value !== "object") return typeof value;
	return Object.entries(value)
		.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
		.slice(0, 8)
		.map(([key, item]) => `${key}=${shallowPrimitiveKey(item)}`)
		.join(",");
}

function shallowPrimitiveKey(value: unknown): string {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? String(value)
		: typeof value;
}

function symbolHitKey(hit: LspSymbolHit): string {
	return [hit.path, hit.start_line, hit.end_line, hit.symbol].join("\0");
}

function publicSymbolHit(seed: WorkspaceSymbolSeed): LspSymbolHit {
	const { uri: _uri, line: _line, character: _character, ...hit } = seed;
	return hit;
}

function publicReferenceHit(candidate: ReferenceHit): LspSymbolHit {
	const { uri: _uri, line: _line, character: _character, ...hit } = candidate;
	return hit;
}

async function createEditSelection(
	client: LspClient,
	write: { readonly changed_ranges?: readonly LspLineRange[]; readonly text: string; readonly filePath: string; readonly baseline?: LspDiagnosticSnapshot },
	source: string,
	uri: string,
): Promise<DiagnosticSelection | undefined> {
	if (write.changed_ranges === undefined) return undefined;
	const changedRanges = write.changed_ranges.map((range: LspLineRange) => ({
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

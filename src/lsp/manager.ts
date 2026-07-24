import path from "node:path";
import pLimit from "p-limit";
import type { WorkspaceSymbol } from "vscode-languageserver-protocol";

import { LspClient } from "./client.js";
import { LspServerRegistry } from "./registry.js";
import { loadLspConfig, normalizeExcludePath, resolveLspConfigPath } from "./config.js";
import { diagnosticSourceKey, DiagnosticsLedger, emptySummary, summarizeDiagnostics } from "./diagnostics.js";
import {
	compactOutline,
	extensionForPath,
	findEnclosingSymbol,
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
	LspEnclosingSymbol,
	LspOutlineItem,
	LspServerConfig,
	LspStatus,
	LspSymbolHit,
} from "./types.js";

const RESOLVE_CONCURRENCY = 4;
const REFERENCE_CONCURRENCY = 4;

interface ClientEntry {
	client: LspClient;
	restarts: number;
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
	extensions: readonly string[];
	allowedPaths: ReadonlySet<string>;
	signal?: AbortSignal;
}

export interface ReadEnhancement {
	/** 截断读取时可返回的紧凑 outline。 */
	outline?: LspOutlineItem[];
	/** partial range 所属的最小包围 symbol。 */
	enclosing_symbol?: LspEnclosingSymbol;
}

/** 进程内 LSP 管理器：负责配置、server 选择、生命周期和 diagnostics ledger。 */
export class LspManager {
	private loaded: LoadedLspConfig | undefined;
	private registry: LspServerRegistry | undefined;
	private configError: string | undefined;
	private reloadPromise: Promise<void> | undefined;
	private reloadRequested = false;
	private activeClientOperations = 0;
	private clientDrainResolve: (() => void) | undefined;
	private readonly clients = new Map<string, ClientEntry>();
	private readonly diagnostics = new DiagnosticsLedger();

	async status(root?: string): Promise<LspStatus> {
		await this.ensureConfig();
		const excluded = root !== undefined && this.loaded !== undefined ? isExcludedRoot(root, this.loaded.config.exclude_paths) : false;
		return {
			enabled: (this.loaded?.config.enabled ?? false) && !excluded,
			config_path: this.loaded?.path ?? resolveLspConfigPath(),
			...(this.configError !== undefined ? { last_error: this.configError } : {}),
			servers: Array.from(this.clients.values()).map((entry) => entry.client.status()),
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
		this.loaded = undefined;
		this.registry = undefined;
		this.configError = undefined;
	}

	async readEnhancement(root: string, filePath: string, text: string, range: { startLine: number; endLine: number }, options: { outline: boolean; enclosing: boolean }): Promise<ReadEnhancement | undefined> {
		const config = await this.enabledConfig();
		if (config === undefined || isExcludedRoot(root, config.config.exclude_paths)) return undefined;
		const client = await this.clientForFile(root, filePath);
		if (client === undefined) return undefined;
		const symbols = await client.documentSymbols(filePath, text);
		if (symbols === undefined) return undefined;
		const result: ReadEnhancement = {};
		if (options.outline && config.config.read.outline) {
			const outline = compactOutline(symbols, config.config.read.max_symbols);
			if (outline.length > 0) result.outline = outline;
		}
		if (options.enclosing) {
			const enclosing = findEnclosingSymbol(symbols, range.startLine, range.endLine);
			if (enclosing !== undefined) result.enclosing_symbol = enclosing;
		}
		return Object.keys(result).length === 0 ? undefined : result;
	}

	async workspaceSymbols(input: WorkspaceSymbolsInput): Promise<LspSymbolHit[]> {
		const config = await this.enabledConfig();
		if (
			config === undefined
			|| isExcludedRoot(input.root, config.config.exclude_paths)
			|| !config.config.grep.workspace_symbols
			|| config.config.grep.max_symbols <= 0
			|| input.allowedPaths.size === 0
		) return [];
		const servers = this.registry?.forExtensions(input.extensions) ?? [];
		if (servers.length === 0) return [];

		const allowedPaths = new Set(input.allowedPaths);
		const operation = createOperationDeadline(input.signal, config.config.request_timeout_ms);
		try {
			const serverResults = await Promise.all(servers.map(async (server) => {
				if (operation.signal.aborted) return undefined;
				const client = await this.clientForServer(input.root, server);
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
						if (seed === undefined || !allowedPaths.has(seed.path)) continue;
						const key = symbolHitKey(seed);
						if (seenRaw.has(key)) continue;
						seenRaw.add(key);
						candidates.push({ kind: "complete", client: result.client, seed });
						continue;
					}
					if (!hasUriOnlyWorkspaceSymbolLocation(symbol) || typeof symbol.name !== "string" || typeof symbol.kind !== "number") continue;
					const relative = relativePathForUri(input.root, symbol.location.uri);
					if (relative === undefined || !allowedPaths.has(relative)) continue;
					const key = unresolvedSymbolKey(symbol);
					if (seenRaw.has(key)) continue;
					seenRaw.add(key);
					candidates.push({ kind: "resolve", client: result.client, symbol });
				}
			}

			const accepted: AcceptedSymbol[] = [];
			const seenHits = new Set<string>();
			const resolveLimit = pLimit(RESOLVE_CONCURRENCY);
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
						return seed === undefined || !allowedPaths.has(seed.path) ? undefined : { client: candidate.client, seed };
					});
				}));
				for (const result of resolved) {
					if (result === undefined) continue;
					const key = symbolHitKey(result.seed);
					if (seenHits.has(key)) continue;
					seenHits.add(key);
					accepted.push(result);
					if (accepted.length >= config.config.grep.max_symbols) break;
				}
			}

			const symbolHits = accepted.map(({ seed }) => publicSymbolHit(seed));
			if (!config.config.grep.references || config.config.grep.max_references <= 0 || operation.signal.aborted) return symbolHits;
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
				if (operation.signal.aborted) return [];
				const locations = await client.references(seed.uri, seed.line, seed.character, operation.requestOptions());
				return locations === undefined || operation.signal.aborted ? [] : referenceHits(root, seed, locations);
			})));
			for (const candidates of results) {
				for (const candidate of candidates) {
					if (!allowedPaths.has(candidate.path)) continue;
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
		const config = await this.enabledConfig();
		if (config === undefined || isExcludedRoot(root, config.config.exclude_paths) || !config.config.diagnostics.enabled) return undefined;
		const source = this.diagnosticSourceForFile(root, filePath);
		if (source === undefined) return undefined;
		return this.diagnostics.snapshot(source, pathToFileUri(filePath));
	}

	async didWrite(root: string, filePath: string, text: string, baseline?: LspDiagnosticSnapshot): Promise<LspDiagnosticsSummary | undefined> {
		const config = await this.enabledConfig();
		if (config === undefined || isExcludedRoot(root, config.config.exclude_paths) || !config.config.diagnostics.enabled) return undefined;
		const expectedSource = this.diagnosticSourceForFile(root, filePath);
		const uri = pathToFileUri(filePath);
		const client = await this.clientForFile(root, filePath);
		if (client === undefined) return emptySummary("unavailable", baselineState(baseline, expectedSource, uri));
		const source = client.diagnosticSource();
		const capturedRevision = this.diagnostics.revision(source, uri);
		const changed = await client.didOpenOrChange(filePath, text);
		if (!changed) return emptySummary("unavailable", baselineState(baseline, source, uri));
		const saved = await client.didSave(filePath, text);
		if (!saved) return emptySummary("unavailable", baselineState(baseline, source, uri));
		const snapshot = await this.diagnostics.waitForNewer(
			source,
			uri,
			capturedRevision,
			config.config.diagnostics.max_wait_ms,
			config.config.diagnostics.settle_ms,
		);
		if (snapshot === undefined) {
			return summarizeDiagnostics(this.diagnostics.snapshot(source, uri), baseline, config.config.diagnostics.max_items, "timeout");
		}
		return summarizeDiagnostics(snapshot, baseline, config.config.diagnostics.max_items);
	}

	async knownDiagnostics(root: string, filePath?: string): Promise<Array<{ path: string; items: LspDiagnosticsSummary["items"] }>> {
		await this.ensureConfig();
		const sources = new Set((this.registry?.servers ?? []).map((server) => diagnosticSourceKey(root, server.id)));
		const entries = this.diagnostics.all();
		return entries.flatMap((entry) => {
			if (!sources.has(entry.source)) return [];
			const absolute = uriToWorkspacePath(root, entry.uri);
			if (absolute === undefined) return [];
			if (filePath !== undefined && absolute.path !== filePath && absolute.relative !== filePath) return [];
			return [{ path: absolute.relative, items: entry.items }];
		});
	}

	private diagnosticSourceForFile(root: string, filePath: string): string | undefined {
		const server = this.registry?.forExtension(extensionForPath(filePath));
		return server === undefined ? undefined : diagnosticSourceKey(root, server.id);
	}

	private async clientForFile(root: string, filePath: string): Promise<LspClient | undefined> {
		const config = await this.enabledConfig();
		if (config === undefined || isExcludedRoot(root, config.config.exclude_paths)) return undefined;
		const server = this.registry?.forExtension(extensionForPath(filePath));
		if (server === undefined) return undefined;
		return this.clientForServer(root, server);
	}

	private async clientForServer(root: string, server: LspServerConfig): Promise<LspClient | undefined> {
		await this.waitForReload();
		this.activeClientOperations += 1;
		try {
			const loaded = await this.enabledConfig();
			if (loaded === undefined) return undefined;
			const key = diagnosticSourceKey(root, server.id);
			let entry = this.clients.get(key);
			if (entry === undefined) {
				entry = { restarts: 0, client: this.createClient(key, root, server, loaded) };
				this.clients.set(key, entry);
			} else if (entry.client.status().status === "crashed" && entry.restarts < loaded.config.max_restarts) {
				entry.restarts += 1;
				await entry.client.shutdown();
				entry.client = this.createClient(key, root, server, loaded);
			}
			const ready = await entry.client.ensureReady();
			return ready ? entry.client : undefined;
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
		this.configError = message;
	}

	private async enabledConfig(): Promise<LoadedLspConfig | undefined> {
		const loaded = await this.ensureConfig();
		if (loaded === undefined || !loaded.config.enabled) return undefined;
		return loaded;
	}

	private async ensureConfig(): Promise<LoadedLspConfig | undefined> {
		if (this.loaded !== undefined || this.configError !== undefined) return this.loaded;
		try {
			this.loaded = await loadLspConfig();
			this.registry = new LspServerRegistry(this.loaded.config.servers);
			return this.loaded;
		} catch (error) {
			this.configError = error instanceof Error ? error.message : String(error);
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

function relativePathForUri(root: string, uri: string): string | undefined {
	const filePath = fileUriToPath(uri);
	return filePath === undefined ? undefined : workspaceRelativePath(root, filePath);
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

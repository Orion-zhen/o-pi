import path from "node:path";

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
	workspaceSymbolSeeds,
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

interface ClientEntry {
	client: LspClient;
	restarts: number;
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

	async workspaceSymbols(root: string, query: string, extensions: readonly string[]): Promise<LspSymbolHit[]> {
		const config = await this.enabledConfig();
		if (config === undefined || isExcludedRoot(root, config.config.exclude_paths) || !config.config.grep.workspace_symbols) return [];
		const servers = this.registry?.forExtensions(extensions) ?? [];
		const hits: LspSymbolHit[] = [];
		let symbolCount = 0;
		let referenceCount = 0;
		for (const server of servers) {
			if (symbolCount >= config.config.grep.max_symbols) break;
			const client = await this.clientForServer(root, server);
			if (client === undefined) continue;
			const symbols = await client.workspaceSymbols(query);
			const seeds: WorkspaceSymbolSeed[] = [];
			for (const original of symbols ?? []) {
				if (seeds.length >= config.config.grep.max_symbols - symbolCount) break;
				let symbol = original;
				if (workspaceSymbolLocation(symbol) === undefined) {
					if (!hasUriOnlyWorkspaceSymbolLocation(symbol)) continue;
					const resolved = await client.resolveWorkspaceSymbol(symbol);
					if (resolved === undefined || workspaceSymbolLocation(resolved) === undefined) continue;
					symbol = resolved;
				}
				const seed = workspaceSymbolSeeds(root, query, [symbol], 1)[0];
				if (seed !== undefined) seeds.push(seed);
			}
			symbolCount += seeds.length;
			hits.push(...seeds.map(({ uri: _uri, line: _line, character: _character, ...hit }) => hit));
			if (config.config.grep.references) {
				for (const seed of seeds) {
					const remaining = config.config.grep.max_references - referenceCount;
					if (remaining <= 0) break;
					const references = await client.references(seed.uri, seed.line, seed.character);
					const referenceCandidates = references === undefined ? [] : referenceHits(root, seed, references, remaining);
					hits.push(...referenceCandidates);
					referenceCount += referenceCandidates.length;
				}
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

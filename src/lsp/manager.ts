import path from "node:path";

import { LspClient } from "./client.js";
import { loadLspConfig, resolveLspConfigPath } from "./config.js";
import { DiagnosticsLedger, emptySummary, summarizeDiagnostics } from "./diagnostics.js";
import { compactOutline, extensionForPath, findEnclosingSymbol, referenceHits, workspaceSymbolSeeds } from "./symbols.js";
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
	private configError: string | undefined;
	private readonly clients = new Map<string, ClientEntry>();
	private readonly diagnostics = new DiagnosticsLedger();

	async status(): Promise<LspStatus> {
		await this.ensureConfig();
		return {
			enabled: this.loaded?.config.enabled ?? false,
			config_path: this.loaded?.path ?? resolveLspConfigPath(),
			...(this.configError !== undefined ? { last_error: this.configError } : {}),
			servers: Array.from(this.clients.values()).map((entry) => entry.client.status()),
		};
	}

	async reload(): Promise<void> {
		await Promise.all(Array.from(this.clients.values()).map((entry) => entry.client.shutdown()));
		this.clients.clear();
		this.diagnostics.clear();
		this.loaded = undefined;
		this.configError = undefined;
	}

	async readEnhancement(root: string, filePath: string, text: string, range: { startLine: number; endLine: number }, options: { outline: boolean; enclosing: boolean }): Promise<ReadEnhancement | undefined> {
		const config = await this.enabledConfig();
		if (config === undefined) return undefined;
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

	async workspaceSymbols(root: string, query: string): Promise<LspSymbolHit[]> {
		const config = await this.enabledConfig();
		if (config === undefined || !config.config.grep.workspace_symbols) return [];
		const servers = enabledServersForExtension(config.config.servers, undefined);
		const hits: LspSymbolHit[] = [];
		let symbolCount = 0;
		let referenceCount = 0;
		for (const server of servers) {
			if (symbolCount >= config.config.grep.max_symbols) break;
			const client = await this.clientForServer(root, server);
			if (client === undefined) continue;
			const symbols = await client.workspaceSymbols(query);
			const seeds = workspaceSymbolSeeds(root, query, symbols, config.config.grep.max_symbols - symbolCount);
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

	async beforeDiagnostics(filePath: string): Promise<LspDiagnosticSnapshot> {
		return this.diagnostics.snapshot(pathToFileUri(filePath));
	}

	async didWrite(root: string, filePath: string, text: string, baseline?: LspDiagnosticSnapshot): Promise<LspDiagnosticsSummary | undefined> {
		const config = await this.enabledConfig();
		if (config === undefined || !config.config.diagnostics.enabled) return undefined;
		const client = await this.clientForFile(root, filePath);
		if (client === undefined) return emptySummary("unavailable", baseline?.known === true ? "known" : "unknown");
		const changed = await client.didOpenOrChange(filePath, text);
		if (!changed) return emptySummary("unavailable", baseline?.known === true ? "known" : "unknown");
		await client.didSave(filePath, text);
		const waited = await this.waitDiagnostics(pathToFileUri(filePath), config.config.diagnostics.max_wait_ms, config.config.diagnostics.settle_ms);
		if (!waited) return summarizeDiagnostics(this.diagnostics.snapshot(pathToFileUri(filePath)), baseline, config.config.diagnostics.max_items, "timeout");
		return summarizeDiagnostics(this.diagnostics.snapshot(pathToFileUri(filePath)), baseline, config.config.diagnostics.max_items);
	}

	async knownDiagnostics(root: string, filePath?: string): Promise<Array<{ path: string; items: LspDiagnosticsSummary["items"] }>> {
		await this.ensureConfig();
		const entries = this.diagnostics.all();
		return entries.flatMap((entry) => {
			const absolute = uriToWorkspacePath(root, entry.uri);
			if (absolute === undefined) return [];
			if (filePath !== undefined && absolute.path !== filePath && absolute.relative !== filePath) return [];
			return [{ path: absolute.relative, items: entry.items }];
		});
	}

	private async waitDiagnostics(uri: string, maxWaitMs: number, settleMs: number): Promise<boolean> {
		const start = Date.now();
		const previous = this.diagnostics.lastUpdatedAt(uri);
		while (Date.now() - start <= maxWaitMs) {
			const updated = this.diagnostics.lastUpdatedAt(uri);
			if (updated !== undefined && updated !== previous && Date.now() - updated >= settleMs) return true;
			await delay(25);
		}
		return previous !== undefined;
	}

	private async clientForFile(root: string, filePath: string): Promise<LspClient | undefined> {
		const config = await this.enabledConfig();
		if (config === undefined) return undefined;
		const server = enabledServersForExtension(config.config.servers, extensionForPath(filePath))[0];
		if (server === undefined) return undefined;
		return this.clientForServer(root, server);
	}

	private async clientForServer(root: string, server: LspServerConfig): Promise<LspClient | undefined> {
		const loaded = await this.enabledConfig();
		if (loaded === undefined) return undefined;
		const key = `${path.resolve(root)}\0${server.id}`;
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
			return this.loaded;
		} catch (error) {
			this.configError = error instanceof Error ? error.message : String(error);
			return undefined;
		}
	}
}

function enabledServersForExtension(servers: LspServerConfig[], extension: string | undefined): LspServerConfig[] {
	return servers.filter((server) => server.enabled && (extension === undefined || server.extensions.includes(extension)));
}

function uriToWorkspacePath(root: string, uri: string): { path: string; relative: string } | undefined {
	const absolute = pathFromFileUri(uri);
	if (absolute === undefined) return undefined;
	const relative = workspaceRelativePath(root, absolute);
	if (relative === undefined) return undefined;
	return { path: absolute, relative };
}

function pathFromFileUri(uri: string): string | undefined {
	return fileUriToPath(uri);
}

async function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

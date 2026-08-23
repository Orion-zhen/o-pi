import path from "node:path";

import { LspClient } from "../client/client.js";
import { loadLspConfig, normalizeExcludePath, resolveLspConfigPath } from "../config/loader.js";
import { diagnosticSourceKey, DiagnosticsLedger } from "../diagnostics/ledger.js";
import { LspServerRegistry } from "../config/registry.js";
import type {
	LoadedLspConfig,
	LspFileRoute,
	LspServerConfig,
	LspStatus,
} from "../types.js";
import { workspaceRelativePath } from "../protocol/uri.js";

/** 共享 LSP client 的配置、路由和生命周期状态。 */
export class LspManagerRuntime {
	private readonly loaded = new Map<string, LoadedLspConfig>();
	private readonly registries = new Map<string, LspServerRegistry>();
	private readonly configErrors = new Map<string, string>();
	private reloadPromise: Promise<void> | undefined;
	private activeClientOperations = 0;
	private clientDrainResolve: (() => void) | undefined;
	private readonly clients = new Map<string, LspClient>();
	readonly diagnostics = new DiagnosticsLedger();

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
				.filter((client) => client.root === normalizedRoot)
				.map((client) => client.status()),
		};
	}

	async reload(): Promise<void> {
		if (this.reloadPromise !== undefined) return this.reloadPromise;
		const pending = Promise.resolve().then(() => this.performReload());
		this.reloadPromise = pending;
		try {
			await pending;
		} finally {
			if (this.reloadPromise === pending) this.reloadPromise = undefined;
		}
	}

	async withClientOperation<T>(operation: () => Promise<T>): Promise<T> {
		await this.admitClientOperation();
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

	async enabledConfig(root: string): Promise<LoadedLspConfig | undefined> {
		const loaded = await this.ensureConfig(root);
		if (loaded === undefined || !loaded.config.enabled) return undefined;
		return loaded;
	}

	async ensureConfig(root: string): Promise<LoadedLspConfig | undefined> {
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

	async clientForFile(root: string, filePath: string): Promise<LspClient | undefined> {
		const config = await this.enabledConfig(root);
		if (config === undefined || isExcludedRoot(root, config.config.exclude_paths)) return undefined;
		const route = this.routeForFile(root, filePath);
		return route === undefined ? undefined : this.clientForServer(root, route.server);
	}

	routeForFile(root: string, filePath: string): LspFileRoute | undefined {
		const relativePath = workspaceRelativePath(root, filePath);
		return relativePath === undefined ? undefined : this.routeForRelativePath(root, relativePath);
	}

	routeForRelativePath(root: string, relativePath: string): LspFileRoute | undefined {
		const normalizedRoot = path.resolve(root);
		try {
			return this.registries.get(normalizedRoot)?.route(relativePath);
		} catch (error) {
			this.setConfigError(normalizedRoot, error);
			return undefined;
		}
	}

	serversForPaths(root: string, paths: Iterable<string>): LspServerConfig[] {
		const normalizedRoot = path.resolve(root);
		try {
			return this.registries.get(normalizedRoot)?.forPaths(paths) ?? [];
		} catch (error) {
			this.setConfigError(normalizedRoot, error);
			return [];
		}
	}

	serverOwnsPath(root: string, server: LspServerConfig, relativePath: string): boolean {
		const normalizedRoot = path.resolve(root);
		try {
			return this.registries.get(normalizedRoot)?.ownsPath(server, relativePath) ?? false;
		} catch (error) {
			this.setConfigError(normalizedRoot, error);
			return false;
		}
	}

	serversForRoot(root: string): readonly LspServerConfig[] {
		return this.registries.get(path.resolve(root))?.servers ?? [];
	}

	clientsForRoot(root: string): readonly LspClient[] {
		const normalizedRoot = path.resolve(root);
		return Array.from(this.clients.values()).filter((client) => client.root === normalizedRoot);
	}

	diagnosticSourceForFile(root: string, filePath: string): string | undefined {
		const route = this.routeForFile(root, filePath);
		return route === undefined ? undefined : diagnosticSourceKey(root, route.server.id);
	}

	async clientForServer(root: string, server: LspServerConfig): Promise<LspClient | undefined> {
		const loaded = await this.enabledConfig(root);
		if (loaded === undefined) return undefined;
		const key = diagnosticSourceKey(root, server.id);
		let client = this.clients.get(key);
		if (client === undefined) {
			client = new LspClient(path.resolve(root), server, loaded.config, this.diagnostics, (crashed, message) => {
				this.handleCrash(key, crashed, message);
			});
			this.clients.set(key, client);
		}
		return await client.ensureReady() ? client : undefined;
	}

	private async performReload(): Promise<void> {
		if (this.activeClientOperations > 0) {
			await new Promise<void>((resolve) => {
				this.clientDrainResolve = resolve;
			});
		}
		await Promise.allSettled(Array.from(this.clients.values(), (client) => client.shutdown()));
		this.clients.clear();
		this.diagnostics.clear();
		this.loaded.clear();
		this.registries.clear();
		this.configErrors.clear();
	}

	private async admitClientOperation(): Promise<void> {
		while (true) {
			const pending = this.reloadPromise;
			if (pending === undefined) {
				this.activeClientOperations += 1;
				return;
			}
			await pending;
		}
	}

	private handleCrash(key: string, client: LspClient, message: string): void {
		if (this.clients.get(key) !== client) return;
		this.setConfigError(client.root, message);
	}

	private setConfigError(root: string, error: unknown): void {
		this.configErrors.set(path.resolve(root), error instanceof Error ? error.message : String(error));
	}
}

export function isExcludedRoot(root: string, excludePaths: readonly string[]): boolean {
	const normalizedRoot = normalizeExcludePath(root);
	return excludePaths.some((excludePath) => normalizedRoot === normalizeExcludePath(excludePath));
}


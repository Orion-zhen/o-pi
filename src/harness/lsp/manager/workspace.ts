import { LspClient } from "../client/client.js";
import { normalizeExcludePath } from "../config/loader.js";
import { LspServerRegistry } from "../config/registry.js";
import { diagnosticSourceKey, DiagnosticsLedger } from "../diagnostics/ledger.js";
import { workspaceRelativePath } from "../protocol/uri.js";
import type { LoadedLspConfig, LspConfig, LspFileRoute, LspServerConfig, LspStatus } from "../types.js";

/** 同一工作区的配置、文件路由和客户端，只在 reload 时整体替换。 */
export class LspWorkspace {
	readonly config: LspConfig;
	readonly enabled: boolean;
	private readonly registry: LspServerRegistry;
	private readonly clients = new Map<string, LspClient>();
	private lastError: string | undefined;

	constructor(
		readonly root: string,
		private readonly loaded: LoadedLspConfig,
		private readonly diagnostics: DiagnosticsLedger,
	) {
		this.config = loaded.config;
		this.enabled = this.config.enabled && !this.config.exclude_paths.includes(normalizeExcludePath(root));
		this.registry = new LspServerRegistry(this.config.servers);
	}

	status(): LspStatus {
		return {
			enabled: this.enabled,
			config_path: this.loaded.path,
			...(this.lastError === undefined ? {} : { last_error: this.lastError }),
			servers: this.startedClients().map((client) => client.status()),
		};
	}

	routeForFile(filePath: string): LspFileRoute | undefined {
		const relative = workspaceRelativePath(this.root, filePath);
		return relative === undefined ? undefined : this.route(relative);
	}

	route(relativePath: string): LspFileRoute | undefined {
		try {
			return this.registry.route(relativePath);
		} catch (error) {
			this.recordError(error);
			return undefined;
		}
	}

	serversForPaths(paths: Iterable<string>): readonly LspServerConfig[] {
		try {
			return this.registry.forPaths(paths);
		} catch (error) {
			this.recordError(error);
			return [];
		}
	}

	sourceForFile(filePath: string): string | undefined {
		const route = this.routeForFile(filePath);
		return route === undefined ? undefined : diagnosticSourceKey(this.root, route.server.id);
	}

	startedClients(): readonly LspClient[] {
		return [...this.clients.values()];
	}

	async client(server: LspServerConfig): Promise<LspClient | undefined> {
		let client = this.clients.get(server.id);
		if (client === undefined) {
			client = new LspClient(this.root, server, this.config, this.diagnostics, (message) => this.recordError(message));
			this.clients.set(server.id, client);
		}
		return await client.ensureReady() ? client : undefined;
	}

	async shutdown(): Promise<void> {
		await Promise.allSettled(this.startedClients().map((client) => client.shutdown()));
	}

	private recordError(error: unknown): void {
		this.lastError = error instanceof Error ? error.message : String(error);
	}
}

import { matchServerLanguage, validateServerRoutes } from "./routing.js";
import type { LspFileRoute, LspServerConfig } from "./types.js";

/** 配置中的 server ID 或运行时文件路由冲突。 */
export class LspServerRegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LspServerRegistryError";
	}
}

/** 不可变的 server 注册表；所有路由都从这里读取，避免出现第二套筛选规则。 */
export class LspServerRegistry {
	readonly servers: readonly LspServerConfig[];

	constructor(servers: readonly LspServerConfig[]) {
		const ids = new Map<string, number>();
		const snapshot = servers.map((server) => ({
			...server,
			routes: server.routes.map((route) => ({ ...route, selectors: [...route.selectors] })),
			transport: server.transport.type === "stdio"
				? { ...server.transport, args: [...server.transport.args] }
				: { ...server.transport },
		}));

		for (const [index, server] of snapshot.entries()) {
			const previousId = ids.get(server.id);
			if (previousId !== undefined) {
				throw new LspServerRegistryError(
					`LSP server ID "${server.id}" is duplicated at servers[${previousId}] and servers[${index}]`,
				);
			}
			ids.set(server.id, index);
			try {
				validateServerRoutes(server);
			} catch (error) {
				throw new LspServerRegistryError(error instanceof Error ? error.message : String(error));
			}
		}

		this.servers = snapshot;
	}

	route(relativePath: string): LspFileRoute | undefined {
		const candidates: LspFileRoute[] = [];
		for (const server of this.servers) {
			if (!server.enabled) continue;
			const languageId = matchServerLanguage(server, relativePath);
			if (languageId !== undefined) candidates.push({ server, languageId });
		}
		const preferred = candidates.filter((candidate) => !candidate.server.fallback);
		if (preferred.length === 1) return preferred[0];
		if (preferred.length > 1) throw ambiguousRoute(relativePath, preferred);
		if (candidates.length === 1) return candidates[0];
		if (candidates.length > 1) throw ambiguousRoute(relativePath, candidates);
		return undefined;
	}

	/** 查找 scope 中实际文件会使用的 enabled server，按配置顺序去重。 */
	forPaths(paths: Iterable<string>): LspServerConfig[] {
		const selected = new Set<LspServerConfig>();
		for (const filePath of paths) {
			const route = this.route(filePath);
			if (route !== undefined) selected.add(route.server);
		}
		return this.servers.filter((server) => selected.has(server));
	}

	ownsPath(server: LspServerConfig, relativePath: string): boolean {
		return this.route(relativePath)?.server.id === server.id;
	}
}

function ambiguousRoute(relativePath: string, candidates: readonly LspFileRoute[]): LspServerRegistryError {
	return new LspServerRegistryError(
		`LSP path "${relativePath}" matches multiple ${candidates[0]?.server.fallback === true ? "fallback " : ""}servers: ${candidates.map((candidate) => candidate.server.id).join(", ")}`,
	);
}

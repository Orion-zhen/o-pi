import { matchServerLanguage } from "./routing.js";
import type { LspFileRoute, LspServerConfig } from "../types.js";

/** 运行时文件路由冲突。 */
export class LspServerRegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LspServerRegistryError";
	}
}

/** 按规范化配置查找 server 和文件路由，避免出现第二套筛选规则。 */
export class LspServerRegistry {
	readonly servers: readonly LspServerConfig[];

	constructor(servers: readonly LspServerConfig[]) {
		this.servers = servers;
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
		if (isNonEmpty(preferred) && preferred.length > 1) throw ambiguousRoute(relativePath, preferred);
		if (candidates.length === 1) return candidates[0];
		if (isNonEmpty(candidates) && candidates.length > 1) throw ambiguousRoute(relativePath, candidates);
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

function ambiguousRoute(relativePath: string, candidates: readonly [LspFileRoute, ...LspFileRoute[]]): LspServerRegistryError {
	return new LspServerRegistryError(
		`LSP path "${relativePath}" matches multiple ${candidates[0].server.fallback === true ? "fallback " : ""}servers: ${candidates.map((candidate) => candidate.server.id).join(", ")}`,
	);
}

function isNonEmpty<T>(values: readonly T[]): values is readonly [T, ...T[]] {
	return values.length > 0;
}

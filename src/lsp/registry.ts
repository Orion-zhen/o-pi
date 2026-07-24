import type { LspServerConfig } from "./types.js";

/** 配置中 server ID 或文件扩展名冲突。 */
export class LspServerRegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LspServerRegistryError";
	}
}

/** 不可变的 server 注册表；所有路由都从这里读取，避免出现第二套筛选规则。 */
export class LspServerRegistry {
	readonly servers: readonly LspServerConfig[];
	private readonly byExtensionMap: ReadonlyMap<string, LspServerConfig>;

	constructor(servers: readonly LspServerConfig[]) {
		const ids = new Map<string, number>();
		const extensions = new Map<string, { server: LspServerConfig; index: number }>();
		const snapshot = servers.map((server) => ({
			...server,
			extensions: [...server.extensions],
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
			for (const extension of server.extensions) {
				const normalized = extension.toLowerCase();
				const previous = extensions.get(normalized);
				if (previous !== undefined) {
					throw new LspServerRegistryError(
						`LSP extension "${normalized}" is assigned to servers[${previous.index}] ("${previous.server.id}") and servers[${index}] ("${server.id}")`,
					);
				}
				extensions.set(normalized, { server, index });
			}
		}

		this.servers = snapshot;
		this.byExtensionMap = new Map(
			Array.from(extensions, ([extension, entry]) => [extension, entry.server]),
		);
	}

	/** 查找某个文件扩展名对应的 enabled server。 */
	forExtension(extension: string): LspServerConfig | undefined {
		const server = this.byExtensionMap.get(extension.toLowerCase());
		return server?.enabled === true ? server : undefined;
	}

	/** 查找 scope 中涉及的 enabled server，按配置顺序去重。 */
	forExtensions(extensions: readonly string[]): LspServerConfig[] {
		const selected = new Set<LspServerConfig>();
		for (const extension of extensions) {
			const server = this.forExtension(extension);
			if (server !== undefined) selected.add(server);
		}
		return this.servers.filter((server) => selected.has(server));
	}
}

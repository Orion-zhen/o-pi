import path from "node:path";
import which from "which";
import { loadLspConfig } from "../../harness/lsp/config/loader.ts";
import type { GuiLspServers } from "../lsp.ts";

export async function readLspServers(cwd: string): Promise<GuiLspServers> {
	const loaded = await loadLspConfig(cwd);
	return {
		path: loaded.path,
		servers: await Promise.all(loaded.config.servers.map(async (server) => ({
			id: server.id,
			languages: server.routes.map((route) => route.languageId),
			transport: server.transport.type === "stdio"
				? { ...server.transport, executable: await findExecutable(server.transport.command, cwd) }
				: server.transport,
		}))),
	};
}

async function findExecutable(command: string, cwd: string): Promise<string | null> {
	const windows = process.platform === "win32";
	const explicit = command.includes("/") || command.includes(path.sep);
	// 按工作区解析相对 PATH，不改变共享进程的工作目录。Unix 的缺省 PATH 与 spawn 一致。
	const directories = explicit ? [""] : [
		...(windows ? [cwd] : []),
		...(process.env.PATH ?? (windows ? "" : "/usr/bin:/bin")).split(path.delimiter),
	];
	for (const entry of directories) {
		const directory = /^".*"$/.test(entry) ? entry.slice(1, -1) : entry;
		const executable = await which(path.resolve(cwd, directory, command), { nothrow: true });
		if (executable !== null) return executable;
	}
	return null;
}

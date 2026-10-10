import { stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import type { GuiWorkspaceInfo } from "../contract.ts";

export async function listWorkspaces(paths: string[], protectedPaths: string[]): Promise<GuiWorkspaceInfo[]> {
	const homeDirectory = homedir();
	const username = userInfo().username;
	const visible = [...new Set([...protectedPaths, ...paths].filter(Boolean))];
	return Promise.all(visible.map(async (cwd) => {
		let exists: boolean;
		try { exists = (await stat(cwd)).isDirectory(); }
		catch (error) {
			if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))) throw error;
			exists = false;
		}
		const fromHome = relative(homeDirectory, cwd);
		const inHome = fromHome !== ".." && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome);
		return {
			path: cwd,
			exists,
			...(inHome ? { home: { username, suffix: fromHome ? sep + fromHome : "" } } : {}),
		};
	}));
}

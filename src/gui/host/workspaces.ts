import { stat } from "node:fs/promises";
import type { GuiWorkspaceInfo } from "../contract.ts";

export async function listWorkspaces(paths: string[], protectedPaths: string[]): Promise<GuiWorkspaceInfo[]> {
	const visible = [...new Set([...protectedPaths, ...paths].filter(Boolean))];
	return Promise.all(visible.map(async (cwd) => {
		let exists: boolean;
		try { exists = (await stat(cwd)).isDirectory(); }
		catch (error) {
			if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))) throw error;
			exists = false;
		}
		return { path: cwd, exists };
	}));
}

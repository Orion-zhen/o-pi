import { createHash } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { GuiWorkspaceInfo } from "../contract.ts";

const removedDirectory = () => path.join(getAgentDir(), "gui", "removed-workspaces");
const workspaceKey = (cwd: string) => createHash("sha256").update(cwd).digest("hex");
const hasCode = (error: unknown, code: string) => error instanceof Error && "code" in error && error.code === code;

// 每个路径独立存储移除标记，多个宿主修改不同工作区时不会覆盖彼此。
export async function setWorkspaceRemoved(cwd: string, removed: boolean): Promise<void> {
	const file = path.join(removedDirectory(), workspaceKey(cwd));
	if (removed) {
		await mkdir(removedDirectory(), { recursive: true });
		await writeFile(file, "");
	} else {
		try { await unlink(file); }
		catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
	}
}

export async function listWorkspaces(paths: string[], protectedPaths: string[]): Promise<GuiWorkspaceInfo[]> {
	let removed: string[];
	try { removed = await readdir(removedDirectory()); }
	catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
		removed = [];
	}
	const hidden = new Set(removed);
	const visible = [...new Set([...protectedPaths, ...paths].filter(Boolean))]
		.filter((cwd) => protectedPaths.includes(cwd) || !hidden.has(workspaceKey(cwd)));
	return Promise.all(visible.map(async (cwd) => {
		let exists: boolean;
		try { exists = (await stat(cwd)).isDirectory(); }
		catch (error) {
			if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTDIR")) throw error;
			exists = false;
		}
		return { path: cwd, exists };
	}));
}

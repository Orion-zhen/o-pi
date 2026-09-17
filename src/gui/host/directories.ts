import path from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";
import type { GuiDirectories } from "../contract.ts";

export async function listDirectories(directory: string): Promise<GuiDirectories> {
	const current = await realpath(directory);
	const entries = await readdir(current, { withFileTypes: true });
	const children = await Promise.all(entries.map(async (entry) => {
		const target = path.join(current, entry.name);
		if (entry.isSymbolicLink()) {
			try {
				if (!(await stat(target)).isDirectory()) return [];
			} catch (error) {
				if (error instanceof Error && "code" in error && ["ENOENT", "EACCES", "ELOOP"].includes(String(error.code))) return [];
				throw error;
			}
		} else if (!entry.isDirectory()) return [];
		return [{ name: entry.name, path: target }];
	}));
	return { path: current, parent: path.dirname(current), children: children.flat().sort((a, b) => a.name.localeCompare(b.name)) };
}

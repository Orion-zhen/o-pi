import { mkdirSync, readdirSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { getSessionsDir } from "../../../harness/storage/sdk-paths.ts";

const missing = (error: unknown) => error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");

/** 只保存监听句柄。父目录监听负责会话目录的首次创建、删除和替换。 */
export function watchSessionDirectory(changed: (directory: string | null) => void, reportError: (error: unknown) => void): () => void {
	const root = getSessionsDir();
	const parent = path.dirname(root);
	const directories = new Map<string, FSWatcher>();
	let rootWatcher: FSWatcher | undefined;
	let closed = false;
	mkdirSync(parent, { recursive: true });

	function stopRoot() {
		rootWatcher?.close();
		rootWatcher = undefined;
		for (const watcher of directories.values()) watcher.close();
		directories.clear();
	}
	function syncDirectories(replaced?: string | null) {
		if (replaced) {
			directories.get(replaced)?.close();
			directories.delete(replaced);
		}
		const names = new Set(readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name));
		for (const [name, watcher] of directories) {
			if (!names.has(name) || replaced === null) { watcher.close(); directories.delete(name); }
		}
		for (const name of names) {
			if (directories.has(name)) continue;
			try {
				const watcher = watch(path.join(root, name), { persistent: false }, (_event, file) => {
					if (!closed && (file === null || file.endsWith(".jsonl"))) changed(path.join(root, name));
				});
				watcher.on("error", reportError);
				directories.set(name, watcher);
			} catch (error) { if (!missing(error)) throw error; }
		}
	}
	function connectRoot() {
		stopRoot();
		try {
			rootWatcher = watch(root, { persistent: false }, (_event, name) => {
				if (closed) return;
				try { syncDirectories(name); }
				catch (error) { if (!missing(error)) reportError(error); }
				changed(name === null ? null : path.join(root, name));
			});
			rootWatcher.on("error", reportError);
			syncDirectories();
		} catch (error) { stopRoot(); if (!missing(error)) throw error; }
	}
	const parentWatcher = watch(parent, { persistent: false }, (_event, name) => {
		if (closed || name !== null && name !== path.basename(root)) return;
		try { connectRoot(); }
		catch (error) { reportError(error); }
		changed(null);
	});
	parentWatcher.on("error", reportError);
	try { connectRoot(); }
	catch (error) { parentWatcher.close(); throw error; }
	return () => { closed = true; parentWatcher.close(); stopRoot(); };
}

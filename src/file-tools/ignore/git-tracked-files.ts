import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitTrackedFiles {
	paths: ReadonlySet<string>;
	ignoreCase: boolean | undefined;
	fingerprint: string;
}

interface GitCacheEntry {
	marker: string;
	statePaths: string[];
	stateFingerprint: string;
	result: GitTrackedFiles;
}

const cache = new Map<string, GitCacheEntry>();
const pending = new Map<string, Promise<GitCacheEntry>>();

/** 一次性读取 Git index，避免按路径启动 Git 子进程。非 Git 仓库安全退化为空集合。 */
export async function loadGitTrackedFiles(workspaceRoot: string): Promise<GitTrackedFiles> {
	const marker = await fileFingerprint(path.join(workspaceRoot, ".git"));
	const cached = cache.get(workspaceRoot);
	if (cached?.marker === marker) {
		const stateFingerprint = await filesFingerprint(cached.statePaths);
		if (stateFingerprint === cached.stateFingerprint) return cached.result;
	}

	const existing = pending.get(workspaceRoot);
	if (existing !== undefined) return (await existing).result;
	const created = refreshGitState(workspaceRoot, marker);
	pending.set(workspaceRoot, created);
	try {
		const entry = await created;
		cache.set(workspaceRoot, entry);
		return entry.result;
	} finally {
		if (pending.get(workspaceRoot) === created) pending.delete(workspaceRoot);
	}
}

async function refreshGitState(workspaceRoot: string, marker: string): Promise<GitCacheEntry> {
	const statePaths = await resolveGitStatePaths(workspaceRoot);
	const [paths, ignoreCase, stateFingerprint] = await Promise.all([
		readTrackedPaths(workspaceRoot),
		readIgnoreCase(workspaceRoot),
		filesFingerprint(statePaths),
	]);
	const fingerprint = `${marker}|${stateFingerprint}`;
	return { marker, statePaths, stateFingerprint, result: { paths, ignoreCase, fingerprint } };
}

async function resolveGitStatePaths(workspaceRoot: string): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", workspaceRoot, "rev-parse", "--path-format=absolute", "--git-path", "index", "--git-path", "config"], {
			encoding: "utf8",
		});
		return stdout.split(/\r?\n/u).filter((value) => value.length > 0);
	} catch {
		return [];
	}
}

async function filesFingerprint(paths: string[]): Promise<string> {
	return (await Promise.all(paths.map(fileFingerprint))).join("|");
}

async function fileFingerprint(filePath: string): Promise<string> {
	try {
		const info = await stat(filePath);
		return `${filePath}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
	} catch {
		return `${filePath}:missing`;
	}
}

async function readTrackedPaths(workspaceRoot: string): Promise<ReadonlySet<string>> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", workspaceRoot, "ls-files", "-z"], {
			encoding: "buffer",
			maxBuffer: 20 * 1024 * 1024,
		});
		const text = stdout.toString("utf8");
		return new Set(text.split("\0").filter((entry) => entry !== ""));
	} catch {
		return new Set();
	}
}

async function readIgnoreCase(workspaceRoot: string): Promise<boolean | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", workspaceRoot, "config", "--get", "core.ignoreCase"], {
			encoding: "utf8",
		});
		const value = stdout.trim().toLowerCase();
		if (value === "true") return true;
		if (value === "false") return false;
		return undefined;
	} catch {
		return undefined;
	}
}

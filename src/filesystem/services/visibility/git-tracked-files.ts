import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { NativeFileSystemError, type NativeFileSystem } from "../../platform/node/native-filesystem.js";
import { SharedBuild } from "./shared-build.js";

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

/** Visibility-owned Git index loader. Git and metadata failures intentionally fail open. */
export class GitTrackedFilesLoader {
	private readonly cache = new Map<string, GitCacheEntry>();
	private readonly pending = new Map<string, SharedBuild<GitCacheEntry>>();
	private epoch = 0;

	constructor(private readonly native: NativeFileSystem) {}

	async load(workspaceRoot: string, signal?: AbortSignal): Promise<GitTrackedFiles> {
		const marker = await this.fileFingerprint(path.join(workspaceRoot, ".git"), signal);
		const cached = this.cache.get(workspaceRoot);
		if (cached?.marker === marker) {
			const stateFingerprint = await this.filesFingerprint(cached.statePaths, signal);
			if (stateFingerprint === cached.stateFingerprint) return cached.result;
		}

		let pending = this.pending.get(workspaceRoot);
		if (pending === undefined) {
			const epoch = this.epoch;
			const created = new SharedBuild(
				async (ownerSignal) => {
					const entry = await this.refreshGitState(workspaceRoot, marker, ownerSignal);
					if (this.epoch === epoch) this.cache.set(workspaceRoot, entry);
					return entry;
				},
				{
					createConsumerAbort: () => new NativeFileSystemError("aborted", "git", workspaceRoot),
					onSettled: () => {
						if (this.pending.get(workspaceRoot) === created) this.pending.delete(workspaceRoot);
					},
				},
			);
			this.pending.set(workspaceRoot, created);
			pending = created;
		}
		return (await pending.consume(signal)).result;
	}

	clear(): void {
		this.epoch += 1;
		this.cache.clear();
		for (const pending of this.pending.values()) pending.abort();
		this.pending.clear();
	}

	private async refreshGitState(workspaceRoot: string, marker: string, signal?: AbortSignal): Promise<GitCacheEntry> {
		const statePaths = await resolveGitStatePaths(workspaceRoot, signal);
		const [paths, ignoreCase, stateFingerprint] = await Promise.all([
			readTrackedPaths(workspaceRoot, signal),
			readIgnoreCase(workspaceRoot, signal),
			this.filesFingerprint(statePaths, signal),
		]);
		const fingerprint = `${marker}|${stateFingerprint}`;
		return { marker, statePaths, stateFingerprint, result: { paths, ignoreCase, fingerprint } };
	}

	private async filesFingerprint(paths: readonly string[], signal?: AbortSignal): Promise<string> {
		return (await Promise.all(paths.map(async (filePath) => await this.fileFingerprint(filePath, signal)))).join("|");
	}

	private async fileFingerprint(filePath: string, signal?: AbortSignal): Promise<string> {
		try {
			const info = await this.native.lstat(filePath, signal === undefined ? {} : { signal });
			return `${filePath}:${info.version ?? `${info.kind}:${info.sizeBytes}:${info.modifiedAtMs}`}`;
		} catch (error) {
			if (error instanceof NativeFileSystemError && error.code === "aborted") throw error;
			return `${filePath}:missing`;
		}
	}
}

async function resolveGitStatePaths(workspaceRoot: string, signal?: AbortSignal): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", workspaceRoot, "rev-parse", "--path-format=absolute", "--git-path", "index", "--git-path", "config"], {
			encoding: "utf8",
			...(signal === undefined ? {} : { signal }),
		});
		return stdout.split(/\r?\n/u).filter((value) => value.length > 0);
	} catch (error) {
		throwIfAborted(error, signal, workspaceRoot);
		return [];
	}
}

async function readTrackedPaths(workspaceRoot: string, signal?: AbortSignal): Promise<ReadonlySet<string>> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", workspaceRoot, "ls-files", "-z"], {
			encoding: "buffer",
			maxBuffer: 20 * 1024 * 1024,
			...(signal === undefined ? {} : { signal }),
		});
		return new Set(stdout.toString("utf8").split("\0").filter((entry) => entry !== ""));
	} catch (error) {
		throwIfAborted(error, signal, workspaceRoot);
		return new Set();
	}
}

async function readIgnoreCase(workspaceRoot: string, signal?: AbortSignal): Promise<boolean | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", workspaceRoot, "config", "--get", "core.ignoreCase"], {
			encoding: "utf8",
			...(signal === undefined ? {} : { signal }),
		});
		const value = stdout.trim().toLowerCase();
		if (value === "true") return true;
		if (value === "false") return false;
		return undefined;
	} catch (error) {
		throwIfAborted(error, signal, workspaceRoot);
		return undefined;
	}
}

function throwIfAborted(error: unknown, signal: AbortSignal | undefined, workspaceRoot: string): void {
	if (signal?.aborted === true || (error instanceof Error && error.name === "AbortError")) {
		throw new NativeFileSystemError("aborted", "git", workspaceRoot, { cause: error });
	}
}

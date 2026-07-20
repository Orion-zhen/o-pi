import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import type { GitRevision } from "./types.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 2_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** Best-effort Git provenance. Git failure means absent provenance, never a failed run. */
export async function captureGitRevision(cwd: string): Promise<GitRevision | undefined> {
	try {
		const [identity, status] = await Promise.all([
			git(cwd, ["rev-parse", "--show-toplevel", "HEAD"]),
			git(cwd, ["status", "--porcelain=v1", "-z"]),
		]);
		const separator = identity.lastIndexOf("\n", identity.length - 2);
		if (separator < 0) return undefined;
		const root = identity.slice(0, separator).trim();
		const commit = identity.slice(separator + 1).trim();
		const dirty = status.length > 0;
		if (!dirty) return { root, commit, dirty: false };
		const diff = await git(cwd, ["diff", "--binary", "HEAD", "--"]);
		return {
			root,
			commit,
			dirty: true,
			dirty_diff_hash: createHash("sha256").update(status).update("\0").update(diff).digest("hex"),
		};
	} catch {
		return undefined;
	}
}

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: GIT_MAX_BUFFER,
		windowsHide: true,
	});
	return result.stdout;
}

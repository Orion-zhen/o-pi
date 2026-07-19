import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { RepoMapError, throwIfAborted } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface RepositoryIdentity {
	repositoryRoot: string;
	worktreeRoot: string;
	gitCommonDir: string;
	headRevision?: string;
}

export interface GitCommandResult {
	stdout: string;
}

export type GitRunner = (cwd: string, args: string[], signal?: AbortSignal) => Promise<GitCommandResult>;

export async function detectRepository(cwd: string, options: { signal?: AbortSignal; runGit?: GitRunner; readHead?: boolean } = {}): Promise<RepositoryIdentity> {
	throwIfAborted(options.signal);
	const runGit = options.runGit ?? defaultGitRunner;
	let output: GitCommandResult;
	try {
		output = await runGit(cwd, ["rev-parse", "--is-bare-repository", "--show-toplevel", "--git-common-dir"], options.signal);
	} catch (error) {
		if (isAbortError(error) || options.signal?.aborted === true) throw new RepoMapError("OPERATION_ABORTED", "Repo Map initialization cancelled.", error);
		if (isExecutableMissing(error)) throw new RepoMapError("GIT_UNAVAILABLE", "Git is not available; Repo Map requires a Git worktree.", error);
		throw new RepoMapError("NOT_GIT_WORKTREE", "Current directory is not inside a Git worktree.", error);
	}
	const lines = output.stdout.trim().split(/\r?\n/u);
	const bare = lines[0];
	const rootText = lines[1];
	const commonText = lines.slice(2).join("\n");
	if (bare !== "false" || rootText === undefined || rootText.length === 0 || commonText.length === 0) {
		throw new RepoMapError("NOT_GIT_WORKTREE", "Current directory is not inside a non-bare Git worktree.");
	}
	const worktreeRoot = await canonicalPath(rootText);
	const commonCandidate = path.isAbsolute(commonText) ? commonText : path.resolve(cwd, commonText);
	const gitCommonDir = await canonicalPath(commonCandidate);
	const headRevision = options.readHead === false
		? undefined
		: await readHeadRevision(worktreeRoot, {
			runGit,
			...(options.signal !== undefined ? { signal: options.signal } : {}),
		});
	return {
		repositoryRoot: worktreeRoot,
		worktreeRoot,
		gitCommonDir,
		...(headRevision !== undefined ? { headRevision } : {}),
	};
}

export async function readHeadRevision(
	worktreeRoot: string,
	options: { signal?: AbortSignal; runGit?: GitRunner } = {},
): Promise<string | undefined> {
	throwIfAborted(options.signal);
	try {
		const result = await (options.runGit ?? defaultGitRunner)(worktreeRoot, ["rev-parse", "--verify", "HEAD"], options.signal);
		const revision = result.stdout.trim();
		return /^[0-9a-fA-F]{40,64}$/u.test(revision) ? revision.toLowerCase() : undefined;
	} catch (error) {
		if (isAbortError(error) || options.signal?.aborted === true) throw new RepoMapError("OPERATION_ABORTED", "Repo Map initialization cancelled.", error);
		if (isExecutableMissing(error)) throw new RepoMapError("GIT_UNAVAILABLE", "Git is not available; Repo Map requires a Git worktree.", error);
		return undefined;
	}
}

async function defaultGitRunner(cwd: string, args: string[], signal?: AbortSignal): Promise<GitCommandResult> {
	const result = await execFileAsync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
		...(signal !== undefined ? { signal } : {}),
	});
	return { stdout: result.stdout };
}

async function canonicalPath(value: string): Promise<string> {
	return path.normalize(await realpath(path.resolve(value)));
}

function isExecutableMissing(error: unknown): boolean {
	return isErrorWithCode(error, "ENOENT");
}

function isAbortError(error: unknown): boolean {
	return isErrorWithCode(error, "ABORT_ERR") || (error instanceof Error && error.name === "AbortError");
}

function isErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

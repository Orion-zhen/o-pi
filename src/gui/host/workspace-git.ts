import { execFile } from "node:child_process";
import path from "node:path";
import { realpath } from "node:fs/promises";
import type { GitChange, GitStatus, WorkspaceGit } from "../workbench.ts";

export function runGit(cwd: string, args: string[], signal: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile("git", ["--no-optional-locks", "--literal-pathspecs", ...args], {
			cwd, signal, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 15_000,
			env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
		}, (error, stdout, stderr) => {
			if (!error) resolve({ code: 0, stdout, stderr });
			else if (typeof error.code === "number" && !error.killed) resolve({ code: error.code, stdout, stderr });
			else reject(error);
		});
	});
}
export async function gitOutput(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
	const result = await runGit(cwd, args, signal);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `Git 退出码 ${result.code}`);
	return result.stdout;
}

export async function gitRoot(cwd: string, signal: AbortSignal): Promise<string | null> {
	const result = await runGit(cwd, ["rev-parse", "--show-toplevel"], signal);
	if (result.code === 128 && result.stderr.includes("not a git repository")) return null;
	if (result.code !== 0) throw new Error(result.stderr.trim());
	return result.stdout.trimEnd();
}

export async function readWorkspaceGit(cwd: string, signal: AbortSignal): Promise<WorkspaceGit | null> {
	cwd = await realpath(cwd);
	const root = await gitRoot(cwd, signal);
	if (!root) return null;
	const [branch, output] = await Promise.all([
		runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal),
		gitOutput(cwd, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all", "--", "."], signal),
	]);
	if (branch.code !== 0 && branch.code !== 1) throw new Error(branch.stderr.trim());
	const label = branch.code === 0 ? branch.stdout.trimEnd()
		: `detached ${ (await gitOutput(cwd, ["rev-parse", "--short", "HEAD"], signal)).trimEnd() }`;
	const relative = (name: string) => path.relative(cwd, path.resolve(root, name)).split(path.sep).join("/").replace(/\/$/, "");
	const changes: GitChange[] = [];
	const ignored: string[] = [];
	const records = output.split("\0");
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record) continue;
		const xy = record.slice(0, 2);
		const name = relative(record.slice(3));
		const original = /[RC]/.test(xy) ? records[++index] : undefined;
		if (name === ".." || name.startsWith("../")) continue;
		if (xy === "!!") { ignored.push(name); continue; }
		let status: GitStatus;
		if (xy.includes("U") || xy === "AA" || xy === "DD") status = "U";
		else if (xy === "??") status = "?";
		else if (xy.includes("R")) status = "R";
		else if (xy.includes("C")) status = "C";
		else if (xy.includes("D")) status = "D";
		else if (xy.includes("A")) status = "A";
		else status = "M";
		changes.push({ path: name, status, ...(original === undefined ? {} : { originalPath: relative(original) }) });
	}
	return { branch: label, changes, ignored };
}

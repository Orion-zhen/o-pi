import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitTrackedFiles {
	paths: ReadonlySet<string>;
	ignoreCase: boolean | undefined;
}

/** 一次性读取 Git index，避免按路径启动 Git 子进程。非 Git 仓库安全退化为空集合。 */
export async function loadGitTrackedFiles(workspaceRoot: string): Promise<GitTrackedFiles> {
	const [paths, ignoreCase] = await Promise.all([readTrackedPaths(workspaceRoot), readIgnoreCase(workspaceRoot)]);
	return { paths, ignoreCase };
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

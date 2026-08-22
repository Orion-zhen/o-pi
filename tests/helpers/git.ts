import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 创建不受全局 fsmonitor 与签名配置影响的最小 Git 仓库。 */
export async function initializeGitRepository(root: string): Promise<string> {
	const trackedFile = path.join(root, "tracked.txt");
	await execGit(root, ["init", "--quiet"]);
	await execGit(root, ["config", "core.fsmonitor", "false"]);
	await writeFile(trackedFile, "tracked\n");
	await execGit(root, ["add", "--", path.basename(trackedFile)]);
	await execGit(root, [
		"-c", "user.name=Test",
		"-c", "user.email=test@example.com",
		"-c", "commit.gpgsign=false",
		"commit", "--quiet", "-m", "initial",
	]);
	// 先稳定提交后的 index，再由测试单独使 stat 信息失效。
	await execGit(root, ["status", "--porcelain"]);
	return trackedFile;
}

export async function execGit(root: string, args: readonly string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
	return stdout;
}

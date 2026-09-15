import path from "node:path";
import { binaryResourceDir, installationRoot } from "./paths.ts";

/** CLI/Web 使用独立二进制，Desktop 的协调进程使用内置 Node 入口。 */
export function cliInvocation(args: string[]): { command: string; args: string[]; env?: NodeJS.ProcessEnv } {
	if (process.versions.electron !== undefined) {
		const desktopEntry = process.argv[1];
		if (desktopEntry === undefined) throw new Error("Desktop 缺少后台入口。");
		return { command: process.execPath, args: [desktopEntry, ...args], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
	}
	return binaryResourceDir === undefined
		? { command: "bun", args: [path.join(installationRoot(), "src", "cli.ts"), ...args] }
		: { command: process.execPath, args };
}

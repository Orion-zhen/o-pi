import path from "node:path";
import { binaryResourceDir, installationRoot } from "./paths.ts";

/** 源码模式使用共享无界面入口，打包后复用当前可执行文件。 */
export function childInvocation(args: string[]): { command: string; args: string[]; env?: NodeJS.ProcessEnv } {
	if (process.versions.electron !== undefined) {
		const desktopEntry = process.argv[1];
		if (desktopEntry === undefined) throw new Error("Desktop 缺少后台入口。");
		return { command: process.execPath, args: [desktopEntry, ...args], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
	}
	return binaryResourceDir === undefined
		? { command: "bun", args: [path.join(installationRoot(), "src/harness/runtime/headless.ts"), ...args] }
		: { command: process.execPath, args };
}

/** 在应用启动前分流子代理和 Discord 协调进程。 */
export async function runChildProcess(): Promise<boolean> {
	if (process.argv[2] !== "--opi-discord-daemon" && process.env.PI_SUBAGENT_CHILD !== "1") return false;
	await import("./headless.ts");
	return true;
}

import path from "node:path";
import { binaryResourceDir, installationRoot } from "./paths.ts";

/** 产品只支持 Bun 源码入口和当前独立二进制。 */
export function cliInvocation(args: string[]): { command: string; args: string[] } {
	return binaryResourceDir === undefined
		? { command: "bun", args: [path.join(installationRoot(), "src", "cli.ts"), ...args] }
		: { command: process.execPath, args };
}

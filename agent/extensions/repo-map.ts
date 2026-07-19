import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerRepoMapAutoActivation, registerRepoMapCommand } from "../../src/repo-map/commands.js";

/** session 启动时轻量发现已有 Repo Map；仅过期时刷新，未建图仓库保持零扫描。 */
export default function repoMapExtension(pi: Pick<ExtensionAPI, "registerCommand" | "appendEntry" | "on">): void {
	registerRepoMapAutoActivation(pi);
	registerRepoMapCommand(pi);
}

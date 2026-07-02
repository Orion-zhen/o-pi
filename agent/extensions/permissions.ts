import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerPermissionCommands, type PermissionCommandContext } from "../../src/permissions/permission-commands.js";
import { getPermissionServiceRegistry } from "../../src/pi-runtime/permission-service-registry.js";

/** 独立注册权限命令与权限会话状态，避免和文件工具扩展耦合。 */
export default function permissions(pi: ExtensionAPI): void {
	const registry = getPermissionServiceRegistry();
	const serviceFor = (ctx: PermissionCommandContext) => registry.serviceFor(ctx);

	registerPermissionCommands(pi, serviceFor);
	pi.on("session_start", () => {
		registry.clear("session_start");
	});
	pi.on("session_shutdown", () => {
		registry.clear("session_shutdown");
	});
}

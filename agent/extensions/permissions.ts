import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { promptContextFromUi, registerPermissionCommands, type PermissionCommandContext } from "../../src/permissions/permission-commands.js";
import { getPermissionServiceRegistry } from "../../src/pi-runtime/permission-service-registry.js";
import { ToolAdapter } from "../../src/permissions/permission-service.js";

/** 独立注册权限命令与权限会话状态，避免和文件工具扩展耦合。 */
export default function permissions(pi: ExtensionAPI): void {
	const registry = getPermissionServiceRegistry();
	const serviceFor = async (ctx: PermissionCommandContext) => {
		const service = await registry.serviceFor(ctx);
		await service.syncRegisteredTools(pi.getAllTools());
		return service;
	};

	registerPermissionCommands(pi, serviceFor);
	pi.on("session_start", () => {
		registry.clear("session_start");
	});
	pi.on("session_shutdown", () => {
		registry.clear("session_shutdown");
	});
	pi.on("tool_call", async (event, ctx) => {
		const service = await serviceFor(ctx);
		const result = await new ToolAdapter(service).authorize({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			normalizedToolInput: event.input,
			promptContext: promptContextFromUi(ctx, 120000),
		});
		if (!result.allowed) return { block: true, reason: result.error.message };
		return undefined;
	});
}

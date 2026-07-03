import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { promptContextFromUi, registerSecurityCommands, type SecurityCommandContext } from "../../src/security/config/commands.js";
import { getSecurityServiceRegistry } from "../../src/pi-runtime/security-service-registry.js";

/** 独立注册权限命令与权限会话状态，避免和文件工具扩展耦合。 */
export default function permissions(pi: ExtensionAPI): void {
	const registry = getSecurityServiceRegistry();
	const serviceFor = async (ctx: SecurityCommandContext) => {
		const service = await registry.serviceFor(ctx);
		await service.syncRegisteredTools(pi.getAllTools());
		return service;
	};

	registerSecurityCommands(pi, serviceFor);
	pi.on("session_start", () => {
		registry.clear("session_start");
	});
	pi.on("session_shutdown", () => {
		registry.clear("session_shutdown");
	});
	pi.on("tool_call", async (event, ctx) => {
		const service = await serviceFor(ctx);
		try {
			await service.prepareToolCall({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				normalizedToolInput: event.input,
				promptContext: promptContextFromUi(ctx, 120000),
			});
		} catch (error) {
			return { block: true, reason: error instanceof Error ? error.message : String(error) };
		}
		return undefined;
	});
}

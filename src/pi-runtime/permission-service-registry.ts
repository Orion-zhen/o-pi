import { getAgentDir } from "@earendil-works/pi-coding-agent";
import path from "node:path";

import { resolveWorkspaceRoot } from "../file-tools/path-security.js";
import { PermissionService } from "../permissions/permission-service.js";

/** Pi 事件和工具执行上下文中创建权限服务所需的最小字段。 */
export interface PermissionServiceRuntimeContext {
	cwd: string;
	isProjectTrusted(): boolean;
	ui?: {
		setStatus(key: string, text: string | undefined): void;
	};
}

/** Pi 扩展运行时共享的权限服务注册表；按 workspace 与信任状态隔离会话授权。 */
export class PermissionServiceRegistry {
	private readonly services = new Map<string, PermissionService>();

	async serviceFor(ctx: PermissionServiceRuntimeContext): Promise<PermissionService> {
		const workspaceRoot = await resolveWorkspaceRoot(ctx.cwd);
		const agentDir = getAgentDir();
		const key = `${workspaceRoot}:${ctx.isProjectTrusted() ? "trusted" : "untrusted"}`;
		const existing = this.services.get(key);
		if (existing !== undefined) return existing;
		const service = new PermissionService({
			workspaceRoot,
			agentDir,
			globalPolicyPath: path.join(agentDir, "pi-permissions.jsonc"),
			projectPolicyPath: path.join(workspaceRoot, ".pi", "permissions.jsonc"),
			projectTrusted: ctx.isProjectTrusted(),
			auditLogPath: path.join(agentDir, "permission-audit.jsonl"),
			auditEnabled: false,
		});
		this.services.set(key, service);
		const status = await service.status();
		ctx.ui?.setStatus("permissions", `PERM: ${status.mode.toUpperCase()}`);
		return service;
	}

	clear(reason: string): void {
		for (const service of this.services.values()) service.cancelAll(reason);
		this.services.clear();
	}
}

const registry = new PermissionServiceRegistry();

/** 返回当前扩展运行时的共享权限服务注册表。 */
export function getPermissionServiceRegistry(): PermissionServiceRegistry {
	return registry;
}

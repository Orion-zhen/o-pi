import { getAgentDir } from "@earendil-works/pi-coding-agent";
import path from "node:path";

import { resolveWorkspaceRoot } from "../file-tools/path-security.js";
import { SecurityService } from "../security/runtime/security-service.js";

export interface SecurityServiceRuntimeContext {
	cwd: string;
	isProjectTrusted(): boolean;
	sessionManager?: { getSessionFile(): string | undefined };
	ui?: {
		setStatus(key: string, text: string | undefined): void;
	};
}

/** Pi 扩展运行时共享 security service；按 workspace、session、trust 隔离。 */
export class SecurityServiceRegistry {
	private readonly services = new Map<string, SecurityService>();

	async serviceFor(ctx: SecurityServiceRuntimeContext): Promise<SecurityService> {
		const workspaceRoot = await resolveWorkspaceRoot(ctx.cwd);
		const agentDir = getAgentDir();
		const sessionId = ctx.sessionManager?.getSessionFile() ?? "ephemeral";
		const key = `${workspaceRoot}:${sessionId}:${ctx.isProjectTrusted() ? "trusted" : "untrusted"}`;
		const existing = this.services.get(key);
		if (existing !== undefined) return existing;
		const service = new SecurityService({
			workspaceRoot,
			agentDir,
			globalPolicyPath: path.join(agentDir, "permissions.jsonc"),
			projectPolicyPath: path.join(workspaceRoot, ".pi", "permissions.jsonc"),
			projectTrusted: ctx.isProjectTrusted(),
			auditLogPath: path.join(agentDir, "security-state", "audit.jsonl"),
			grantPath: path.join(agentDir, "security-state", "grants.json"),
			sessionId,
		});
		this.services.set(key, service);
		const status = await service.status();
		ctx.ui?.setStatus("security", `SEC: ${status.components.length} components`);
		return service;
	}

	clear(_reason: string): void {
		for (const service of this.services.values()) service.cancelAll();
		this.services.clear();
	}
}

const registry = new SecurityServiceRegistry();

export function getSecurityServiceRegistry(): SecurityServiceRegistry {
	return registry;
}

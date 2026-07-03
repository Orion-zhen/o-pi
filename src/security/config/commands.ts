import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { ApprovalPromptContext, UserApprovalChoice } from "../approval/approval.js";
import { approvalSummary } from "../explain/user-policy-explainer.js";
import { isUserPermissionMode } from "./user-config.js";
import type { SecurityService } from "../runtime/security-service.js";
import { formatCatalog } from "../catalog/permission-catalog.js";

export type SecurityCommandContext = Pick<ExtensionCommandContext, "cwd" | "isProjectTrusted" | "sessionManager" | "ui">;

export function promptContextFromUi(ctx: SecurityCommandContext, timeoutMs: number): ApprovalPromptContext {
	return {
		hasUI: ctx.ui !== undefined,
		timeoutMs,
		prompt: async (request, decision) => {
			const alwaysAsk = decision.riskLabels.includes("approval:always-ask");
			const message = approvalSummary(request, requestPolicyFallback()).replace("配置结果：ask", `配置结果：${alwaysAsk ? "always-ask" : "ask"}`);
			const suffix = alwaysAsk
				? "\n\n按钮：允许本次 / 拒绝"
				: "\n\n按钮：允许一次 / 本次 Agent 会话允许 / 永久允许 / 拒绝";
			const allowed = await ctx.ui?.confirm?.("Security approval", `${message}${suffix}`, { timeout: timeoutMs });
			return allowed ? "allow-once" : "deny";
		},
	};
}

export function registerSecurityCommands(api: ExtensionAPI, serviceFor: (ctx: SecurityCommandContext) => Promise<SecurityService>): void {
	api.registerCommand("permissions", {
		description: "Inspect security policy",
		async handler(args, ctx) {
			const service = await serviceFor(ctx);
			const status = await service.status();
			let output: string;
			if (args.trim() === "catalog") {
				output = formatCatalog(status.catalog);
			} else if (args.trim().startsWith("explain ")) {
				output = await handleExplain(service, args.trim().slice("explain ".length));
			} else if (args.trim().startsWith("set ")) {
				output = await handleSet(service, args.trim().slice("set ".length));
			} else if (args.trim() === "schema") {
				await service.writePermissionSchema();
				output = "permissions.schema.json 已更新";
			} else {
				output = [
					`项目信任：${status.projectTrusted ? "是" : "否"}`,
					`工具：${status.catalog.tools.filter((entry) => entry.available).length}`,
					`MCP：${status.catalog.mcpServers.reduce((count, server) => count + server.tools.filter((tool) => server.available && tool.available).length, 0)}`,
					`Skills：${status.catalog.skills.filter((entry) => entry.available).length}`,
					`Agents：${status.catalog.agents.filter((entry) => entry.available).length}`,
				].join("\n");
			}
			ctx.ui.notify(output, "info");
		},
	});
}

export function approvalChoiceFromLabel(label: string): UserApprovalChoice {
	if (label === "Allow exact request for this Agent session") return "allow-session-exact";
	if (label === "Allow subtree for this Agent session") return "allow-session-subtree";
	if (label === "Create persistent rule") return "create-persistent-rule";
	if (label === "Allow once") return "allow-once";
	return "deny";
}

async function handleExplain(service: SecurityService, text: string): Promise<string> {
	const tokens = text.split(/\s+/).filter(Boolean);
	const agentIndex = tokens.indexOf("agent");
	if (agentIndex < 0 || tokens[agentIndex + 1] === undefined) return explainUsage();
	const agent = tokens[agentIndex + 1]!;
	const pathIndex = tokens.indexOf("path");
	const queryPath = pathIndex >= 0 ? tokens[pathIndex + 1] : undefined;
	if (tokens.includes("tool")) {
		const name = tokens[tokens.indexOf("tool") + 1];
		if (name === undefined) return explainUsage();
		return await service.explain({ agent, kind: "tool", name, ...(queryPath !== undefined ? { path: queryPath } : {}) });
	}
	if (tokens.includes("mcp")) {
		const name = tokens[tokens.indexOf("mcp") + 1];
		if (name === undefined) return explainUsage();
		return await service.explain({ agent, kind: "mcp", name, ...(queryPath !== undefined ? { path: queryPath } : {}) });
	}
	if (tokens.includes("skill")) {
		const name = tokens[tokens.indexOf("skill") + 1];
		if (name === undefined) return explainUsage();
		return await service.explain({ agent, kind: "skill", name, ...(queryPath !== undefined ? { path: queryPath } : {}) });
	}
	if (tokens.includes("subagent")) {
		const name = tokens[tokens.indexOf("subagent") + 1];
		if (name === undefined) return explainUsage();
		return await service.explain({ agent, kind: "subagent", name, ...(queryPath !== undefined ? { path: queryPath } : {}) });
	}
	return explainUsage();
}

async function handleSet(service: SecurityService, text: string): Promise<string> {
	const tokens = text.split(/\s+/).filter(Boolean);
	const [level, levelNameOrCategory, maybeCategory, maybeName, maybeMode] = tokens;
	const isAgent = level === "agent";
	if (level !== "global" && !isAgent) return setUsage();
	const category = isAgent ? maybeCategory : levelNameOrCategory;
	const name = isAgent ? maybeName : maybeCategory;
	const mode = isAgent ? maybeMode : maybeName;
	if (category === undefined || name === undefined || !isSetCategory(category) || !isUserPermissionMode(mode)) return setUsage();
	await service.setUserMode({
		level,
		...(isAgent ? { agent: levelNameOrCategory } : {}),
		category,
		name,
		mode,
	});
	return "权限配置已更新";
}

function isSetCategory(value: string): value is "tool" | "mcp" | "skill" | "subagent" {
	return value === "tool" || value === "mcp" || value === "skill" || value === "subagent";
}

function explainUsage(): string {
	return "用法：/permissions explain agent <name> tool|mcp|skill|subagent <name> [path <path>]";
}

function setUsage(): string {
	return "用法：/permissions set global|agent <agent> tool|mcp|skill|subagent <name> off|allow|ask|always-ask";
}

function requestPolicyFallback() {
	return {
		componentEnablement: { defaultComponent: "disabled" as const, global: {}, agents: {} },
		boundaries: { defaultAuthorization: "deny" as const, paths: [] },
		forbids: { rules: [] },
		permits: { rules: [] },
		consent: { rules: [] },
	};
}

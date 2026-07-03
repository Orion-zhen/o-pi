import path from "node:path";

import type { AuthorizationRequest } from "../model/types.js";
import { maybeWorkspaceRelative } from "../runtime/path-utils.js";
import { componentKey, compiledPathRuleMatches, filePathFromResource } from "../config/user-policy-compiler.js";
import { modeRank, strictestMode, type UserPermissionMode } from "../config/user-config.js";
import type { CompiledSecurityPolicy, CompiledUserPolicy } from "../policy/policy.js";

export interface ExplainQuery {
	agent: string;
	kind: "tool" | "mcp" | "skill" | "subagent";
	name: string;
	path?: string;
}

export function explainUserPolicy(policy: CompiledSecurityPolicy, query: ExplainQuery, workspaceRoot: string): string {
	if (policy.userModes === undefined) return "结果：无法解释\n\n当前策略不是用户配置编译结果。";
	const component = componentKeyFromQuery(query);
	const base = policy.userModes.baseModes[query.agent]?.[component] ?? policy.userModes.baseModes.main?.[component];
	const lines: string[] = [];
	const modes: UserPermissionMode[] = [];
	if (base !== undefined) {
		for (const source of base.sources) lines.push(`${source.label} = ${source.mode}`);
		modes.push(base.mode);
	} else {
		lines.push(`Agent ${query.agent}：未配置，继承 off`);
		modes.push("off");
	}
	if (query.path !== undefined) {
		const resolved = path.resolve(workspaceRoot, query.path);
		for (const rule of policy.userModes.pathRules) {
			if (!compiledPathRuleMatches(rule, resolved, workspaceRoot)) continue;
			const pathMode = rule.modes[query.agent]?.[component] ?? rule.modes["*"]?.[component];
			if (pathMode === undefined) continue;
			lines.push(`${pathMode.source}：${pathMode.mode}`);
			modes.push(pathMode.mode);
		}
	}
	const finalMode = strictestMode(...modes) ?? "off";
	return [`结果：${modeLabel(finalMode)}`, "", ...lines, `最终模式：${finalMode}`].join("\n");
}

export function approvalSummary(request: AuthorizationRequest, policy: CompiledSecurityPolicy): string {
	if (policy.userModes === undefined) {
		return [`Agent：${request.principal.agentDefinitionId}`, `组件：${request.component.displayName}`, "配置结果：ask"].join("\n");
	}
	const key = componentKey(request.component);
	const agent = request.principal.agentDefinitionId;
	const modes: UserPermissionMode[] = [];
	const sources: string[] = [];
	const base = policy.userModes.baseModes[agent]?.[key] ?? policy.userModes.baseModes.main?.[key];
	if (base !== undefined) {
		modes.push(base.mode);
		sources.push(...base.sources.map((source) => `  ${source.label} = ${source.mode}`));
	}
	for (const atom of request.atoms) {
		const filePath = filePathFromResource(atom.resource);
		if (filePath === undefined) continue;
		for (const rule of policy.userModes.pathRules) {
			if (!compiledPathRuleMatches(rule, filePath, policy.userModes.workspaceRoot)) continue;
			const pathMode = rule.modes[agent]?.[key] ?? rule.modes["*"]?.[key];
			if (pathMode === undefined) continue;
			modes.push(pathMode.mode);
			sources.push(`  ${pathMode.source} ${componentVisibleName(request)} = ${pathMode.mode}`);
		}
	}
	const mode = strictestMode(...modes) ?? "off";
	return [
		`Agent：${agent}`,
		componentLine(request),
		...fileLines(request, policy.userModes),
		`配置结果：${mode}`,
		"来源：",
		...sources,
		...(request.component.kind === "bash" ? ["说明：Bash 是不透明进程执行能力"] : []),
	].join("\n");
}

function componentKeyFromQuery(query: ExplainQuery): string {
	if (query.kind === "tool" && query.name === "bash") return "bash:bash";
	if (query.kind === "tool") return `tool:${query.name}`;
	if (query.kind === "mcp") return `mcp-tool:${query.name}`;
	if (query.kind === "skill") return `skill:${query.name}`;
	return `agent:${query.name}`;
}

function componentLine(request: AuthorizationRequest): string {
	if (request.component.kind === "bash") return "工具：bash";
	if (request.component.kind === "mcp-tool") return `MCP：${request.component.displayName}`;
	if (request.component.kind === "skill") return `Skill：${request.component.displayName}`;
	if (request.component.kind === "agent") return `启动 Agent：${request.component.displayName}`;
	return `工具：${request.component.displayName}`;
}

function componentVisibleName(request: AuthorizationRequest): string {
	return request.component.kind === "bash" ? "bash" : request.component.displayName;
}

function fileLines(request: AuthorizationRequest, userPolicy: CompiledUserPolicy): string[] {
	const paths = new Set<string>();
	for (const atom of request.atoms) {
		const filePath = filePathFromResource(atom.resource);
		if (filePath === undefined) continue;
		paths.add(maybeWorkspaceRelative(userPolicy.workspaceRoot, filePath, true) ?? filePath);
	}
	return [...paths].map((entry) => `路径：${entry}`);
}

function modeLabel(mode: UserPermissionMode): string {
	if (mode === "allow") return "允许";
	if (mode === "ask") return "需要审批";
	if (mode === "always-ask") return "每次审批";
	return "关闭";
}

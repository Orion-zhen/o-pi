import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PermissionCatalog } from "../catalog/permission-catalog.js";
import type { ComponentIdentity, ComponentKind } from "../model/types.js";
import { expandConfiguredPath, isPathInside } from "../runtime/path-utils.js";
import type { CompiledAtomRule, CompiledSecurityPolicy, CompiledUserModeRule, CompiledUserPolicy, ConsentIndex } from "../policy/policy.js";
import { modeRank, strictestMode, type UserMcpModeMap, type UserModeMap, type UserPermissionConfig, type UserPermissionMode, type UserPermissionSection } from "./user-config.js";

export interface CompileUserPolicyInput {
	global: UserPermissionConfig;
	project?: UserPermissionConfig;
	catalog: PermissionCatalog;
	workspaceRoot: string;
	agentDir: string;
}

export interface UserPolicyCompileResult {
	policy: CompiledSecurityPolicy;
	diagnostics: string[];
}

interface VisibleComponent {
	key: string;
	name: string;
	kind: ComponentKind;
	server?: string;
	tool?: string;
	identityDigest: string;
}

interface ModeSource {
	label: string;
	mode: UserPermissionMode;
}

/** 用户配置到内部 IR 的唯一编译入口。运行时只消费 CompiledSecurityPolicy。 */
export function compileUserPermissionPolicy(input: CompileUserPolicyInput): UserPolicyCompileResult {
	const components = visibleComponents(input.catalog);
	const agentNames = input.catalog.agents.filter((agent) => agent.available).map((agent) => agent.name);
	const diagnostics = input.project === undefined ? [] : validateNoProjectLoosening(input.global, input.project, components, agentNames);
	const merged = mergeConfigs(input.global, input.project);
	const userModes = compileUserModes(merged, components, agentNames, input.workspaceRoot, input.agentDir);
	return {
		diagnostics,
		policy: {
			componentEnablement: {
				defaultComponent: "disabled",
				global: componentCeilingFromModes(userModes.baseModes, components, "main"),
				agents: Object.fromEntries(agentNames.map((agent) => [agent, componentCeilingFromModes(userModes.baseModes, components, agent)])),
			},
			boundaries: { defaultAuthorization: "deny", paths: [] },
			forbids: { rules: [] },
			permits: { rules: permitRulesFromModes(userModes.baseModes, components) },
			consent: consentFromModes(userModes.baseModes, components),
			userModes,
		},
	};
}

function compileUserModes(
	config: UserPermissionConfig,
	components: readonly VisibleComponent[],
	agentNames: readonly string[],
	workspaceRoot: string,
	agentDir: string,
): CompiledUserPolicy {
	const allAgents = new Set(["main", ...agentNames, ...Object.keys(config.agents ?? {})]);
	const baseModes: Record<string, Record<string, { mode: UserPermissionMode; sources: ModeSource[] }>> = {};
	for (const agent of [...allAgents].sort()) {
		baseModes[agent] = {};
		for (const component of components) {
			const global = modeFromSection(config.global, component, "off");
			const agentMode = modeFromSection(config.agents?.[agent], component, global.mode);
			const mode = strictestMode(global.mode, agentMode.mode) ?? "off";
			baseModes[agent]![component.key] = {
				mode,
				sources: [
					{ label: `全局 ${component.name}`, mode: global.mode },
					...(config.agents?.[agent] === undefined ? [] : [{ label: `Agent ${agent} ${component.name}`, mode: agentMode.mode }]),
				],
			};
		}
	}
	const pathRules = (config.paths ?? []).map((rule, index): CompiledUserModeRule => {
		const match = rule.match === undefined ? undefined : expandConfiguredPath(rule.match, { workspace: workspaceRoot, agentDir }).replace(/\\/g, "/");
		const modes: CompiledUserModeRule["modes"] = {};
		for (const [agentPattern, section] of Object.entries(rule.agents)) {
			modes[agentPattern] = {};
			for (const component of components) {
				const parent = baseModes[agentPattern]?.[component.key]?.mode ?? modeFromSection(config.global, component, "off").mode;
				const configured = modeFromSection(section, component, parent);
				modes[agentPattern]![component.key] = {
					mode: strictestMode(parent, configured.mode) ?? "off",
					source: rule.match === undefined ? "路径 outsideWorkspace" : `路径 ${rule.match}`,
				};
			}
		}
		return {
			id: `path-${index}`,
			...(match !== undefined ? { match } : {}),
			...(rule.outsideWorkspace === true ? { outsideWorkspace: true } : {}),
			modes,
		};
	});
	return {
		workspaceRoot,
		agentDir,
		components: Object.fromEntries(components.map((component) => [component.key, component])),
		baseModes,
		pathRules,
		approval: {
			ask: config.approval?.ask?.remember ?? ["once", "session", "persistent"],
			"always-ask": ["once"],
		},
	};
}

function modeFromSection(section: UserPermissionSection | undefined, component: VisibleComponent, inherited: UserPermissionMode): { mode: UserPermissionMode } {
	if (section === undefined) return { mode: inherited };
	if (component.kind === "tool" || component.kind === "bash") return { mode: modeFromMap(section.tools, component.name, inherited) };
	if (component.kind === "skill") return { mode: modeFromMap(section.skills, component.name, inherited) };
	if (component.kind === "agent") return { mode: modeFromMap(section.subagents, component.name, inherited) };
	if (component.kind === "mcp-tool") return { mode: modeFromMcpMap(section.mcp, component.server ?? "", component.tool ?? component.name, inherited) };
	return { mode: inherited };
}

function modeFromMap(map: UserModeMap | undefined, name: string, inherited: UserPermissionMode): UserPermissionMode {
	return map?.[name] ?? map?.["*"] ?? inherited;
}

function modeFromMcpMap(map: UserMcpModeMap | undefined, server: string, tool: string, inherited: UserPermissionMode): UserPermissionMode {
	const serverValue = map?.[server];
	if (typeof serverValue === "string") return serverValue;
	if (serverValue !== undefined) return serverValue[tool] ?? serverValue["*"] ?? inherited;
	const wildcard = map?.["*"];
	return typeof wildcard === "string" ? wildcard : inherited;
}

function mergeConfigs(global: UserPermissionConfig, project: UserPermissionConfig | undefined): UserPermissionConfig {
	if (project === undefined) return global;
	const merged: UserPermissionConfig = {
		version: 1,
		paths: [...(global.paths ?? []), ...(project.paths ?? [])],
		approval: {
			ask: { remember: project.approval?.ask?.remember ?? global.approval?.ask?.remember ?? ["once", "session", "persistent"] },
			"always-ask": { remember: ["once"] },
		},
	};
	if (global.$schema !== undefined) merged.$schema = global.$schema;
	const globalSection = mergeSection(global.global, project.global);
	if (globalSection !== undefined) merged.global = globalSection;
	const agents = mergeAgentSections(global.agents, project.agents);
	if (agents !== undefined) merged.agents = agents;
	const audit = project.audit ?? global.audit;
	if (audit !== undefined) merged.audit = audit;
	return merged;
}

function mergeAgentSections(
	global: Record<string, UserPermissionSection> | undefined,
	project: Record<string, UserPermissionSection> | undefined,
): Record<string, UserPermissionSection> | undefined {
	const names = new Set([...Object.keys(global ?? {}), ...Object.keys(project ?? {})]);
	if (names.size === 0) return undefined;
	const result: Record<string, UserPermissionSection> = {};
	for (const name of names) {
		const section = mergeSection(global?.[name], project?.[name]);
		if (section !== undefined) result[name] = section;
	}
	return result;
}

function mergeSection(global: UserPermissionSection | undefined, project: UserPermissionSection | undefined): UserPermissionSection | undefined {
	if (global === undefined) return project;
	if (project === undefined) return global;
	const result: UserPermissionSection = {};
	const tools = mergeModeMap(global.tools, project.tools);
	if (tools !== undefined) result.tools = tools;
	const mcp = mergeMcpMap(global.mcp, project.mcp);
	if (mcp !== undefined) result.mcp = mcp;
	const skills = mergeModeMap(global.skills, project.skills);
	if (skills !== undefined) result.skills = skills;
	const subagents = mergeModeMap(global.subagents, project.subagents);
	if (subagents !== undefined) result.subagents = subagents;
	return result;
}

function mergeModeMap(global: UserModeMap | undefined, project: UserModeMap | undefined): UserModeMap | undefined {
	const names = new Set([...Object.keys(global ?? {}), ...Object.keys(project ?? {})]);
	if (names.size === 0) return undefined;
	return Object.fromEntries([...names].map((name) => [name, strictestMode(global?.[name], project?.[name]) ?? "off"]));
}

function mergeMcpMap(global: UserMcpModeMap | undefined, project: UserMcpModeMap | undefined): UserMcpModeMap | undefined {
	const names = new Set([...Object.keys(global ?? {}), ...Object.keys(project ?? {})]);
	if (names.size === 0) return undefined;
	return Object.fromEntries([...names].map((name) => [name, mergeMcpValue(global?.[name], project?.[name])]));
}

function mergeMcpValue(global: UserMcpModeMap[string] | undefined, project: UserMcpModeMap[string] | undefined): UserMcpModeMap[string] {
	if (typeof global === "string" || typeof project === "string") {
		return strictestMode(typeof global === "string" ? global : undefined, typeof project === "string" ? project : undefined) ?? "off";
	}
	return mergeModeMap(global, project) ?? {};
}

function validateNoProjectLoosening(
	global: UserPermissionConfig,
	project: UserPermissionConfig,
	components: readonly VisibleComponent[],
	agentNames: readonly string[],
): string[] {
	const diagnostics: string[] = [];
	for (const component of components) {
		const globalMode = modeFromSection(global.global, component, "off").mode;
		const projectMode = modeFromSection(project.global, component, globalMode).mode;
		if (modeRank(projectMode) < modeRank(globalMode)) diagnostics.push(`Project config cannot loosen global ${component.name} from ${globalMode} to ${projectMode}.`);
	}
	for (const agent of agentNames) {
		for (const component of components) {
			const parent = strictestMode(modeFromSection(global.global, component, "off").mode, modeFromSection(global.agents?.[agent], component, "off").mode) ?? "off";
			const projectMode = modeFromSection(project.agents?.[agent], component, parent).mode;
			if (modeRank(projectMode) < modeRank(parent)) diagnostics.push(`Project config cannot loosen Agent ${agent} ${component.name} from ${parent} to ${projectMode}.`);
		}
	}
	return diagnostics;
}

function visibleComponents(catalog: PermissionCatalog): VisibleComponent[] {
	return [
		...catalog.tools.filter((entry) => entry.available).map((entry) => ({
			key: entry.kind === "bash" ? "bash:bash" : `tool:${entry.name}`,
			name: entry.name,
			kind: entry.kind,
			identityDigest: entry.identityDigest,
		})),
		...catalog.mcpServers.flatMap((server) =>
			server.tools.filter((tool) => server.available && tool.available).map((tool) => ({
				key: `mcp-tool:${server.name}/${tool.name}`,
				name: `${server.name}/${tool.name}`,
				kind: "mcp-tool" as const,
				server: server.name,
				tool: tool.name,
				identityDigest: tool.identityDigest,
			})),
		),
		...catalog.skills.filter((entry) => entry.available).map((entry) => ({
			key: `skill:${entry.name}`,
			name: entry.name,
			kind: "skill" as const,
			identityDigest: entry.identityDigest,
		})),
		...catalog.agents.filter((entry) => entry.available).map((entry) => ({
			key: `agent:${entry.name}`,
			name: entry.name,
			kind: "agent" as const,
			identityDigest: entry.identityDigest,
		})),
	];
}

function componentCeilingFromModes(
	baseModes: CompiledUserPolicy["baseModes"],
	components: readonly VisibleComponent[],
	agent: string,
) {
	const enabled = components.filter((component) => baseModes[agent]?.[component.key]?.mode !== "off");
	return {
		tools: enabled.filter((component) => component.kind === "tool").map((component) => component.name),
		bash: enabled.some((component) => component.kind === "bash"),
		mcp: enabled.filter((component) => component.kind === "mcp-tool").map((component) => component.name),
		skills: enabled.filter((component) => component.kind === "skill").map((component) => component.name),
		agents: enabled.filter((component) => component.kind === "agent").map((component) => component.name),
	};
}

function permitRulesFromModes(baseModes: CompiledUserPolicy["baseModes"], components: readonly VisibleComponent[]): CompiledAtomRule[] {
	return Object.entries(baseModes).flatMap(([agent, modes]) =>
		components.flatMap((component): CompiledAtomRule[] => {
			const mode = modes[component.key]?.mode;
			if (mode === undefined || mode === "off") return [];
			return [{
				id: `user-mode-${agent}-${component.key}`,
				actions: ["*"],
				resources: ["*"],
				components: componentCeilingFromSingle(component),
				agents: [agent],
			}];
		}),
	);
}

function consentFromModes(baseModes: CompiledUserPolicy["baseModes"], components: readonly VisibleComponent[]): ConsentIndex {
	return {
		rules: Object.entries(baseModes).flatMap(([agent, modes]) =>
			components.flatMap((component) => {
				const mode = modes[component.key]?.mode;
				if (mode !== "ask" && mode !== "always-ask") return [];
				return [{ actions: ["*"], resources: ["*"], mode, agents: [agent], components: componentCeilingFromSingle(component) }];
			}),
		),
	};
}

function componentCeilingFromSingle(component: VisibleComponent) {
	return {
		tools: component.kind === "tool" ? [component.name] : [],
		bash: component.kind === "bash",
		mcp: component.kind === "mcp-tool" ? [component.name] : [],
		skills: component.kind === "skill" ? [component.name] : [],
		agents: component.kind === "agent" ? [component.name] : [],
	};
}

export function componentKey(component: ComponentIdentity): string {
	if (component.kind === "bash") return "bash:bash";
	return `${component.kind}:${component.displayName}`;
}

export function filePathFromResource(resource: string): string | undefined {
	if (!resource.startsWith("file://")) return undefined;
	try {
		return fileURLToPath(resource);
	} catch {
		return undefined;
	}
}

export function compiledPathRuleMatches(rule: CompiledUserModeRule, filePath: string, workspaceRoot: string): boolean {
	const normalized = path.resolve(filePath).replace(/\\/g, "/");
	if (rule.outsideWorkspace === true) return !isPathInside(workspaceRoot, normalized);
	if (rule.match === undefined) return false;
	const pattern = rule.match.replace(/\\/g, "/");
	if (pattern.endsWith("/**")) return isPathInside(pattern.slice(0, -3), normalized);
	return pattern === normalized;
}

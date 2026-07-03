import picomatch from "picomatch";

import type { AuthorizationAtom, AuthorizationDecision, AuthorizationRequest, ComponentIdentity, ComponentKind } from "../model/types.js";
import { isPathInside } from "../runtime/path-utils.js";
import { compiledPathRuleMatches, componentKey, filePathFromResource } from "../config/user-policy-compiler.js";
import { modeRank, strictestMode, type UserPermissionMode } from "../config/user-config.js";
import { componentNames, type ComponentCeiling } from "./config.js";

export interface EnablementIndex {
	defaultComponent: "enabled" | "disabled";
	global: ComponentCeiling;
	agents: Readonly<Record<string, ComponentCeiling>>;
}

export interface BoundaryIndex {
	defaultAuthorization: "allow" | "ask" | "deny";
	paths: readonly CompiledPathRule[];
}

export interface CompiledPathRule {
	match: string;
	ceiling: ComponentCeiling & { agents?: readonly string[] };
}

export interface ForbidIndex {
	rules: readonly CompiledAtomRule[];
}

export interface PermitIndex {
	rules: readonly CompiledAtomRule[];
}

export interface ConsentIndex {
	rules: readonly {
		actions: readonly string[];
		resources: readonly string[];
		mode: "ask" | "always-ask" | "never";
		components?: ComponentCeiling;
		agents?: readonly string[];
	}[];
}

export interface CompiledUserModeRule {
	id: string;
	match?: string;
	outsideWorkspace?: true;
	modes: Record<string, Record<string, { mode: UserPermissionMode; source: string }>>;
}

export interface CompiledUserPolicy {
	workspaceRoot: string;
	agentDir: string;
	components: Record<string, { key: string; name: string; kind: ComponentKind; identityDigest: string }>;
	baseModes: Record<string, Record<string, { mode: UserPermissionMode; sources: readonly { label: string; mode: UserPermissionMode }[] }>>;
	pathRules: readonly CompiledUserModeRule[];
	approval: {
		ask: readonly ("once" | "session" | "persistent")[];
		"always-ask": readonly ["once"];
	};
}

export interface CompiledAtomRule {
	id: string;
	actions: readonly string[];
	resources: readonly string[];
	components?: ComponentCeiling;
	agents?: readonly string[];
}

export interface CompiledSecurityPolicy {
	componentEnablement: EnablementIndex;
	boundaries: BoundaryIndex;
	forbids: ForbidIndex;
	permits: PermitIndex;
	consent: ConsentIndex;
	userModes?: CompiledUserPolicy;
}

/** 授权 evaluator 为纯函数；I/O、审批和日志由网关在外层处理。 */
export function evaluateAuthorization(request: AuthorizationRequest, policy: CompiledSecurityPolicy): AuthorizationDecision {
	if (request.atoms.length === 0) return deny("empty_atoms", "Executable components must produce at least one authorization atom.");
	if (!componentEnabled(request.component, request.principal.agentDefinitionId, policy.componentEnablement)) {
		return deny("component_disabled", "Component is disabled for this principal.");
	}
	for (const atom of request.atoms) {
		if (controlPlaneFileWrite(atom)) return deny("control_plane", "Control plane files require explicit policy/grant meta permissions.");
		if (matchesAnyRule(atom, request.component, request.principal.agentDefinitionId, policy.forbids.rules)) {
			return deny("explicit_forbid", "Explicit forbid matched.");
		}
		if (!withinDelegation(atom, request)) return deny("delegation", "Delegation capability rejected an atom.");
		if (!withinBoundaries(atom, request, policy.boundaries)) return deny("boundary", "Boundary intersection rejected an atom.");
	}
	if (policy.userModes !== undefined) return evaluateUserModes(request, policy.userModes);
	const permit = request.atoms.every((atom) => matchesAnyRule(atom, request.component, request.principal.agentDefinitionId, policy.permits.rules));
	if (permit) return allow("permit", "Permit matched all atoms.");
	const consent = consentDecision(request, policy.consent);
	if (consent !== undefined) return consent;
	return { kind: policy.boundaries.defaultAuthorization, reason: "Default authorization.", matchedPolicyIds: ["default"], riskLabels: [] };
}

export function componentEnabled(component: ComponentIdentity, agent: string, index: EnablementIndex): boolean {
	const global = componentAllowedByCeiling(component, index.global, index.defaultComponent === "enabled");
	if (!global) return false;
	const agentCeiling = index.agents[agent];
	if (agentCeiling === undefined) return true;
	return componentAllowedByCeiling(component, agentCeiling, false);
}

function withinBoundaries(atom: AuthorizationAtom, request: AuthorizationRequest, boundaries: BoundaryIndex): boolean {
	const matching = matchingPathRules(atom, request, boundaries.paths);
	if (matching.length === 0) return true;
	return matching.every((rule) => {
		if (rule.ceiling.agents !== undefined && !rule.ceiling.agents.includes(request.principal.agentDefinitionId)) return false;
		if (!componentAllowedByCeiling(request.component, rule.ceiling, true)) return false;
		if (rule.ceiling.actions !== undefined && !patternListMatches(rule.ceiling.actions, atom.action)) return false;
		if (rule.ceiling.resources !== undefined && !patternListMatches(rule.ceiling.resources, atom.resource)) return false;
		return true;
	});
}

function matchingPathRules(atom: AuthorizationAtom, request: AuthorizationRequest, rules: readonly CompiledPathRule[]): CompiledPathRule[] {
	const path = atom.resource.startsWith("file://")
		? atom.resource.slice("file://".length)
		: request.principal.scope.root;
	return rules.filter((rule) => matchPath(rule.match, path));
}

function matchesAnyRule(atom: AuthorizationAtom, component: ComponentIdentity, agent: string, rules: readonly CompiledAtomRule[]): boolean {
	return rules.some((rule) => {
		if (!patternListMatches(rule.actions, atom.action)) return false;
		if (!patternListMatches(rule.resources, atom.resource)) return false;
		if (rule.agents !== undefined && !rule.agents.includes(agent)) return false;
		if (rule.components !== undefined && !componentAllowedByCeiling(component, rule.components, true)) return false;
		return true;
	});
}

function withinDelegation(atom: AuthorizationAtom, request: AuthorizationRequest): boolean {
	const delegation = request.principal.delegation;
	if (delegation.expiresAt < Date.now()) return false;
	if (!patternListMatches(delegation.actionPatterns, atom.action)) return false;
	if (!patternListMatches(delegation.resourcePatterns, atom.resource)) return false;
	const filePath = filePathFromResource(atom.resource);
	if (filePath !== undefined && !isPathInside(delegation.scopeRoot, filePath)) return false;
	return true;
}

function consentDecision(request: AuthorizationRequest, consent: ConsentIndex): AuthorizationDecision | undefined {
	let asked = false;
	for (const atom of request.atoms) {
		const rule = consent.rules.find((candidate) =>
			patternListMatches(candidate.actions, atom.action) &&
			patternListMatches(candidate.resources, atom.resource) &&
			(candidate.agents === undefined || candidate.agents.includes(request.principal.agentDefinitionId)) &&
			(candidate.components === undefined || componentAllowedByCeiling(request.component, candidate.components, true))
		);
		if (rule === undefined) continue;
		if (rule.mode === "never") return deny("consent_never", "Consent policy denies this atom.");
		asked = true;
	}
	return asked ? { kind: "ask", reason: "Consent is required.", matchedPolicyIds: ["consent"], riskLabels: ["requires-human-approval"] } : undefined;
}

function evaluateUserModes(request: AuthorizationRequest, userModes: CompiledUserPolicy): AuthorizationDecision {
	const key = componentKey(request.component);
	const base = userModes.baseModes[request.principal.agentDefinitionId]?.[key] ?? userModes.baseModes.main?.[key];
	if (base === undefined || base.mode === "off") return deny("component_disabled", "Component is off for this Agent.");
	let result: UserPermissionMode = base.mode;
	for (const atom of request.atoms) {
		const atomMode = strictestMode(base.mode, ...pathModesForAtom(atom, request.principal.agentDefinitionId, key, userModes)) ?? "off";
		if (modeRank(atomMode) > modeRank(result)) result = atomMode;
	}
	if (result === "off") return deny("component_disabled", "Component is off for this path or Agent.");
	if (result === "allow") return allow("user-mode", "User permission mode allow.");
	return {
		kind: "ask",
		reason: result === "always-ask" ? "User permission mode always-ask." : "User permission mode ask.",
		matchedPolicyIds: [`user-mode:${result}`],
		riskLabels: [`approval:${result}`],
	};
}

function pathModesForAtom(
	atom: AuthorizationAtom,
	agent: string,
	component: string,
	userModes: CompiledUserPolicy,
): UserPermissionMode[] {
	const filePath = filePathFromResource(atom.resource);
	if (filePath === undefined) return [];
	const result: UserPermissionMode[] = [];
	for (const rule of userModes.pathRules) {
		if (!compiledPathRuleMatches(rule, filePath, userModes.workspaceRoot)) continue;
		const mode = rule.modes[agent]?.[component]?.mode ?? rule.modes["*"]?.[component]?.mode;
		if (mode !== undefined) result.push(mode);
	}
	return result;
}

function componentAllowedByCeiling(component: ComponentIdentity, ceiling: ComponentCeiling, defaultValue: boolean): boolean {
	const value = componentNames(ceiling, component.kind);
	if (typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.includes(component.displayName);
	return defaultValue;
}

function patternListMatches(patterns: readonly string[], value: string): boolean {
	return patterns.some((pattern) => pattern === "*" || globMatches(pattern, value));
}

function matchPath(pattern: string, value: string): boolean {
	const normalizedPattern = pattern.replace(/\\/g, "/");
	const normalizedValue = value.replace(/\\/g, "/");
	if (normalizedPattern.endsWith("/**")) return isPathInside(normalizedPattern.slice(0, -3), normalizedValue);
	return globMatches(normalizedPattern, normalizedValue);
}

function globMatches(pattern: string, value: string): boolean {
	return picomatch(pattern, { dot: true, nocase: process.platform === "win32" })(value);
}

function controlPlaneFileWrite(atom: AuthorizationAtom): boolean {
	if (!atom.resource.startsWith("file://")) return false;
	if (!["fs.create", "fs.write", "fs.replace", "fs.delete", "fs.rename"].includes(atom.action)) return false;
	const path = atom.resource.toLowerCase();
	return path.includes("/src/security/") || path.endsWith("/permissions.jsonc") || path.endsWith("/package-lock.json") || path.includes("/permission-state/");
}

function allow(id: string, reason: string): AuthorizationDecision {
	return { kind: "allow", reason, matchedPolicyIds: [id], riskLabels: [] };
}

function deny(id: string, reason: string): AuthorizationDecision {
	return { kind: "deny", reason, matchedPolicyIds: [id], riskLabels: [] };
}

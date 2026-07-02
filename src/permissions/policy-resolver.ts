import path from "node:path";

import { defaultPolicy } from "./policy-loader.js";
import type {
	LoadedPermissionPolicy,
	PermissionAccess,
	PermissionEffect,
	PermissionMode,
	PermissionPolicyFile,
	PermissionRule,
	PermissionToolName,
	PolicyEvaluation,
	PolicyTraceEntry,
} from "./permission-types.js";
import { isWriteAction } from "./permission-types.js";
import { isPathInside, normalizeUserPath, pathDepth } from "./path-utils.js";

export interface PolicyResolverInput {
	workspaceRoot: string;
	global: LoadedPermissionPolicy;
	project: LoadedPermissionPolicy;
	mode: PermissionMode;
	explain?: boolean;
}

interface LayerDecision {
	effect: PermissionEffect;
	source: "builtin" | "global" | "project" | "default";
	rule?: PermissionRule;
	index?: number;
	reason: string;
}

/** 纯策略解析器；不访问 UI，不执行 I/O。 */
export class PolicyResolver {
	constructor(private readonly input: PolicyResolverInput) {}

	evaluateTool(toolName: string): PolicyEvaluation {
		const trace: PolicyTraceEntry[] = [];
		let current: PermissionEffect = "allow";
		let matched: LayerDecision = { effect: current, source: "default", reason: "No tool policy matched; tool remains enabled." };

		if (this.input.global.status === "invalid" || this.input.global.status === "load_failed") {
			current = "ask";
			matched = { effect: current, source: "global", reason: "Global policy failed to load; falling back to ask." };
			if (this.input.explain) trace.push(toTrace(matched));
		} else if (this.input.global.policy !== undefined) {
			const global = evaluateToolPolicy(this.input.global.policy, "global", toolName);
			if (global !== undefined) {
				if (this.input.explain) trace.push(toTrace(global));
				if (global.effect === "deny") return withTrace(deny("global", global.rule?.id ?? "global-tool", global.reason, true), trace);
				current = global.effect;
				matched = global;
			}
		}

		if (this.input.project.policy !== undefined) {
			const project = evaluateToolPolicy(this.input.project.policy, "project", toolName);
			if (project !== undefined) {
				if (this.input.explain) trace.push(toTrace(project));
				if (project.effect === "deny") return withTrace(deny("project", project.rule?.id ?? "project-tool", project.reason, false), trace);
				current = applyProject(current, project.effect);
				matched = project;
			}
		}

		if (this.input.mode === "yolo" && current === "ask") {
			return withTrace({ effect: "allow", reason: "yolo mode allows ordinary ask decisions.", denyFloor: false }, [
				...trace,
				{ source: "mode", effect: "allow", reason: "yolo mode allows ordinary ask decisions." },
			]);
		}

		const evaluation: PolicyEvaluation = {
			effect: current,
			reason: matched.reason,
			denyFloor: false,
		};
		if (matched.rule !== undefined) {
			evaluation.matchedRule = {
				id: matched.rule.id,
				source: matched.source === "default" ? "builtin" : matched.source,
				...(matched.index !== undefined ? { index: matched.index } : {}),
			};
		}
		return withTrace(evaluation, trace);
	}

	evaluate(access: PermissionAccess, toolName: string): PolicyEvaluation {
		const trace: PolicyTraceEntry[] = [];
		if (access.boundary === "sensitive") {
			const result = deny("builtin", "builtin-sensitive-hard-deny", "Sensitive resources are hard denied.", true);
			if (this.input.explain) result.trace = [{ source: "builtin", effect: "deny", ruleId: "builtin-sensitive-hard-deny", reason: result.reason }];
			return result;
		}

		const builtin = evaluatePolicy(defaultPolicy, "builtin", access, toolName, this.input.workspaceRoot);
		if (this.input.explain) trace.push(toTrace(builtin));
		let current = builtin.effect;
		let matched = builtin;

		if (this.input.global.status === "invalid" || this.input.global.status === "load_failed") {
			current = tighten(current, "ask");
			matched = { effect: current, source: "global", reason: "Global policy failed to load; falling back to ask." };
			if (this.input.explain) trace.push(toTrace(matched));
		} else if (this.input.global.policy !== undefined) {
			const global = evaluatePolicy(this.input.global.policy, "global", access, toolName, this.input.workspaceRoot);
			if (this.input.explain) trace.push(toTrace(global));
			if (global.effect === "deny") return withTrace(deny("global", global.rule?.id ?? "global-default", global.reason, true), trace);
			current = applyLayer(current, global.effect);
			matched = global;
		}

		if (this.input.project.policy !== undefined) {
			const project = evaluatePolicy(this.input.project.policy, "project", access, toolName, this.input.workspaceRoot);
			if (this.input.explain) trace.push(toTrace(project));
			if (project.effect === "deny") return withTrace(deny("project", project.rule?.id ?? "project-default", project.reason, false), trace);
			current = applyProject(current, project.effect);
			matched = project;
		}

		if (this.input.mode === "read-only" && isWriteAction(access.action)) {
			return withTrace({ effect: "deny", reason: "read-only mode denies write actions.", denyFloor: false }, [
				...trace,
				{ source: "mode", effect: "deny", reason: "read-only mode denies write actions." },
			]);
		}
		if (this.input.mode === "yolo" && current === "ask") {
			return withTrace({ effect: "allow", reason: "yolo mode allows ordinary ask decisions.", denyFloor: false }, [
				...trace,
				{ source: "mode", effect: "allow", reason: "yolo mode allows ordinary ask decisions." },
			]);
		}

		const evaluation: PolicyEvaluation = {
			effect: current,
			reason: matched.reason,
			denyFloor: false,
		};
		if (matched.rule !== undefined) {
			const matchedRule: NonNullable<PolicyEvaluation["matchedRule"]> = {
				id: matched.rule.id,
				source: matched.source === "default" ? "builtin" : matched.source,
				...(matched.index !== undefined ? { index: matched.index } : {}),
			};
			const sourcePath = this.sourcePath(matched.source);
			if (sourcePath !== undefined) matchedRule.sourcePath = sourcePath;
			evaluation.matchedRule = matchedRule;
		}
		return withTrace(evaluation, trace);
	}

	private sourcePath(source: LayerDecision["source"]): string | undefined {
		if (source === "global") return this.input.global.path;
		if (source === "project") return this.input.project.path;
		return undefined;
	}
}

function evaluateToolPolicy(
	policy: PermissionPolicyFile,
	source: LayerDecision["source"],
	toolName: string,
): LayerDecision | undefined {
	const match = bestToolPattern(policy.tools, toolName);
	if (match === undefined) return undefined;
	return {
		effect: match.effect,
		source,
		rule: {
			id: `tool:${match.pattern}`,
			effect: match.effect,
			tools: ["*"],
			resource: { type: "boundary", boundary: "workspace" },
		},
		index: match.index,
		reason: `Matched ${source} tool policy ${match.pattern}.`,
	};
}

function bestToolPattern(
	tools: Record<string, PermissionEffect> | undefined,
	toolName: string,
): { pattern: string; effect: PermissionEffect; index: number } | undefined {
	if (tools === undefined) return undefined;
	const matches = Object.entries(tools)
		.map(([pattern, effect], index) => ({ pattern, effect, index }))
		.filter((item) => wildcardMatch(item.pattern, toolName));
	return matches[matches.length - 1];
}

function evaluatePolicy(
	policy: PermissionPolicyFile,
	source: LayerDecision["source"],
	access: PermissionAccess,
	toolName: string,
	workspaceRoot: string,
): LayerDecision {
	const rule = bestRule(policy.rules ?? [], access, toolName, workspaceRoot);
	if (rule !== undefined) {
		return { effect: rule.rule.effect, source, rule: rule.rule, index: rule.index, reason: `Matched ${source} rule ${rule.rule.id}.` };
	}
	const defaults = policy.defaults?.[access.boundary];
	const permissionToolName = toPermissionToolName(toolName);
	const exact = permissionToolName === undefined ? undefined : defaults?.[permissionToolName];
	if (exact !== undefined) return { effect: exact, source, reason: `${source} ${access.boundary}.${permissionToolName} default.` };
	const wildcard = defaults?.["*"];
	if (wildcard !== undefined) return { effect: wildcard, source, reason: `${source} ${access.boundary}.* default.` };
	return { effect: "ask", source: "default", reason: "No policy matched; safe default ask." };
}

function bestRule(
	rules: PermissionRule[],
	access: PermissionAccess,
	toolName: string,
	workspaceRoot: string,
): { rule: PermissionRule; index: number } | undefined {
	const matches = rules
		.map((rule, index) => ({ rule, index, score: ruleScore(rule, access, toolName, workspaceRoot, index) }))
		.filter((item): item is { rule: PermissionRule; index: number; score: number[] } => item.score !== undefined);
	matches.sort((left, right) => compareScore(right.score, left.score));
	return matches[0] === undefined ? undefined : { rule: matches[0].rule, index: matches[0].index };
}

function ruleScore(
	rule: PermissionRule,
	access: PermissionAccess,
	toolName: string,
	workspaceRoot: string,
	index: number,
): number[] | undefined {
	const tool = toPermissionToolName(toolName);
	if ((tool === undefined || !rule.tools.includes(tool)) && !rule.tools.includes("*")) return undefined;
	const toolSpecific = tool !== undefined && rule.tools.includes(tool) ? 1 : 0;
	if (rule.resource.type === "boundary") {
		if (rule.resource.boundary !== access.boundary) return undefined;
		return [0, 0, toolSpecific, index];
	}
	const rulePath = normalizeUserPath(workspaceRoot, rule.resource.path);
	const candidates = [access.canonicalPath, access.absolutePath];
	const matched = candidates.some((candidate) =>
		rule.resource.type === "path" && rule.resource.scope === "exact"
			? path.resolve(candidate) === path.resolve(rulePath)
			: isPathInside(rulePath, candidate),
	);
	if (!matched) return undefined;
	const exact = rule.resource.scope === "exact" ? 1 : 0;
	return [exact, pathDepth(rulePath), toolSpecific, index];
}

function toPermissionToolName(toolName: string): PermissionToolName | undefined {
	if (toolName === "ls" || toolName === "read" || toolName === "edit") return toolName;
	return undefined;
}

function wildcardMatch(pattern: string, value: string): boolean {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`).test(value);
}

function compareScore(left: number[], right: number[]): number {
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const value = (left[index] ?? 0) - (right[index] ?? 0);
		if (value !== 0) return value;
	}
	return 0;
}

function applyLayer(current: PermissionEffect, next: PermissionEffect): PermissionEffect {
	if (next === "deny") return "deny";
	return next;
}

function applyProject(current: PermissionEffect, next: PermissionEffect): PermissionEffect {
	if (next === "deny") return "deny";
	if (current === "allow" && next === "ask") return "ask";
	if (current === "ask" && next === "allow") return "allow";
	return current;
}

function tighten(current: PermissionEffect, next: PermissionEffect): PermissionEffect {
	if (current === "deny" || next === "deny") return "deny";
	if (current === "ask" || next === "ask") return "ask";
	return "allow";
}

function deny(
	source: "builtin" | "global" | "project",
	id: string,
	reason: string,
	denyFloor: boolean,
): PolicyEvaluation {
	return { effect: "deny", matchedRule: { id, source }, reason, denyFloor };
}

function withTrace(evaluation: PolicyEvaluation, trace: PolicyTraceEntry[]): PolicyEvaluation {
	if (trace.length > 0) evaluation.trace = trace;
	return evaluation;
}

function toTrace(decision: LayerDecision): PolicyTraceEntry {
	return {
		source: decision.source,
		effect: decision.effect,
		...(decision.rule !== undefined ? { ruleId: decision.rule.id } : {}),
		reason: decision.reason,
	};
}

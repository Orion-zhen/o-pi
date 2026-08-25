import path from "node:path";
import picomatch from "picomatch";

import type { ApprovalAllowRule, ApprovalRequest, ApprovalUnit } from "../types.js";

export interface ApprovalRuleMatcher {
	matchesAllowRule(request: ApprovalRequest, unit: ApprovalUnit): boolean;
}

export function createExactAllowRules(request: ApprovalRequest, units: readonly ApprovalUnit[]): ApprovalAllowRule[] {
	return dedupeRules(units
		.filter((unit) => unit.remember.session)
		.map((unit) => allowRuleForTarget(request, unit, "exact")));
}

export function createSimilarAllowRules(request: ApprovalRequest, units: readonly ApprovalUnit[]): ApprovalAllowRule[] {
	return dedupeRules(units
		.filter((unit) => unit.remember.persistent)
		.map((unit) => allowRuleForTarget(request, unit, "similar")));
}

export function describeAllowRules(rules: readonly ApprovalAllowRule[]): string {
	return rules.map(describeAllowRule).join("; ");
}

function describeAllowRule(rule: ApprovalAllowRule): string {
	if (rule.kind === "command_prefix") return `${rule.tool} commands starting with: ${rule.value} in ${rule.cwd}`;
	if (rule.kind === "exact_command") return `${rule.tool} command: ${rule.value} in ${rule.cwd}`;
	if (rule.kind === "path_glob") return `${rule.tool} paths matching: ${rule.value}`;
	return `${rule.tool} path: ${rule.value}`;
}

export function allowRuleMatches(rule: ApprovalAllowRule, request: ApprovalRequest, unit: ApprovalUnit): boolean {
	if (rule.tool !== request.tool) return false;
	if (rule.kind === "exact_command" || rule.kind === "command_prefix") {
		if (unit.target.kind !== "command") return false;
		if (normalizePath(rule.cwd) !== normalizePath(request.cwd)) return false;
		if (rule.kind === "exact_command") return unit.target.value === rule.value;
		const command = unit.target.similar_value ?? unit.target.match_value;
		return command === rule.value || command.startsWith(`${rule.value} `);
	}
	if (unit.target.kind !== "path") return false;
	const normalizedTarget = normalizePath(unit.target.value);
	if (rule.kind === "exact_path") return normalizedTarget === normalizePath(rule.value);
	return picomatch(normalizePath(rule.value), { dot: true, nonegate: true })(normalizedTarget);
}

function allowRuleForTarget(
	request: ApprovalRequest,
	unit: ApprovalUnit,
	mode: "exact" | "similar",
): ApprovalAllowRule {
	if (unit.target.kind === "command") {
		const prefix = mode === "similar"
			? commandPrefix(unit.target.similar_value ?? unit.target.match_value)
			: undefined;
		return {
			tool: request.tool,
			kind: prefix === undefined ? "exact_command" : "command_prefix",
			value: prefix ?? unit.target.value,
			cwd: request.cwd,
		};
	}
	const normalized = normalizePath(unit.target.value);
	const glob = mode === "similar" ? conservativePathGlob(normalized) : undefined;
	return {
		tool: request.tool,
		kind: glob === undefined ? "exact_path" : "path_glob",
		value: glob ?? normalized,
	};
}

export function dedupeRules(rules: readonly ApprovalAllowRule[]): ApprovalAllowRule[] {
	const seen = new Set<string>();
	const result: ApprovalAllowRule[] = [];
	for (const rule of rules) {
		const cwd = rule.kind === "exact_command" || rule.kind === "command_prefix" ? rule.cwd : "";
		const key = `${rule.tool}\0${rule.kind}\0${rule.value}\0${cwd}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(rule);
	}
	return result;
}

function commandPrefix(command: string): string | undefined {
	for (const prefix of [
		"npm install",
		"npm i",
		"pnpm install",
		"pnpm add",
		"yarn add",
		"pip install",
		"pip3 install",
		"uv pip install",
		"brew install",
		"cargo install",
		"go install",
	]) {
		if (command === prefix || command.startsWith(`${prefix} `)) return prefix;
	}
	return undefined;
}

function conservativePathGlob(targetPath: string): string | undefined {
	const normalized = normalizePath(targetPath);
	const dirname = path.posix.dirname(normalized);
	const basename = path.posix.basename(normalized);
	if (dirname === "/etc/nginx" && basename.length > 0) return "/etc/nginx/**";
	return undefined;
}

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/");
}

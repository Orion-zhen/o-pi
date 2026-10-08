import os from "node:os";
import path from "node:path";

export interface PathIdentity {
	readonly displayPath: string;
	readonly absolutePath: string;
	readonly workspacePath?: string;
}

export type AccessCheckPhase = "lexical" | "canonical" | "parent";

/** 预编译路径规则，并在所有规则之间复用规范化后的路径身份。 */
export class CompiledPathRuleMatcher {
	private readonly rules: readonly CompiledRule[];

	constructor(rules: readonly string[], homeDirectory = os.homedir()) {
		this.rules = rules.map((rule) => compileRule(rule, homeDirectory));
	}

	match(identity: PathIdentity): string | undefined {
		if (this.rules.length === 0) return undefined;
		const normalized = normalizeIdentity(identity);
		for (const rule of this.rules) {
			if (rule.path.length > 0 && identityMatchesRule(normalized, rule)) return rule.source;
		}
		return undefined;
	}
}

interface CompiledRule {
	readonly source: string;
	readonly path: string;
	readonly absolute: boolean;
	readonly directory: boolean;
}

function compileRule(rule: string, homeDirectory: string): CompiledRule {
	const expanded = expandHomePath(rule, homeDirectory);
	const directory = /[\\/]$/u.test(expanded);
	const absolute = path.isAbsolute(expanded);
	const normalized = normalizePath(expanded).replace(/\/+$/u, "");
	return {
		source: rule,
		path: absolute ? normalized : normalized.replace(/^\/+/, ""),
		absolute,
		directory,
	};
}

interface NormalizedPathIdentity {
	readonly displayPath: string;
	readonly absolutePath: string;
	readonly workspacePath?: string;
}

function normalizeIdentity(identity: PathIdentity): NormalizedPathIdentity {
	return {
		displayPath: normalizePath(identity.displayPath),
		absolutePath: normalizePath(identity.absolutePath),
		...(identity.workspacePath === undefined ? {} : { workspacePath: normalizePath(identity.workspacePath) }),
	};
}

function identityMatchesRule(identity: NormalizedPathIdentity, rule: CompiledRule): boolean {
	if (rule.absolute) return matchCandidate(identity.absolutePath, rule.path, rule.directory);
	return matchCandidate(identity.displayPath, rule.path, rule.directory)
		|| (identity.workspacePath !== undefined && matchCandidate(identity.workspacePath, rule.path, rule.directory))
		|| matchCandidate(identity.absolutePath, rule.path, rule.directory);
}

function matchCandidate(candidate: string, rule: string, directory: boolean): boolean {
	if (rule.length === 0) return false;
	if (candidate === rule) return true;
	if (directory && candidate.startsWith(`${rule}/`)) return true;
	if (candidate.endsWith(`/${rule}`)) return true;
	return directory && candidate.includes(`/${rule}/`);
}

export function expandHomePath(value: string, homeDirectory = os.homedir()): string {
	if (value === "~") return homeDirectory;
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homeDirectory, value.slice(2));
	return value;
}

export function resolveNativeInputPath(cwd: string, inputPath: string, homeDirectory = os.homedir()): string {
	return path.resolve(cwd, expandHomePath(inputPath, homeDirectory));
}

export function normalizeLogicalPath(value: string): string {
	return value === "" ? "." : value.replaceAll("\\", "/");
}

function normalizePath(value: string): string {
	return path.normalize(value).replaceAll("\\", "/");
}

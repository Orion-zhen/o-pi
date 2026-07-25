import os from "node:os";
import path from "node:path";

export interface PathIdentity {
	readonly displayPath: string;
	readonly absolutePath: string;
	readonly workspacePath?: string;
}

export type AccessCheckPhase = "lexical" | "canonical" | "parent";

export interface BlockedPathMatch {
	readonly code: "BLOCKED_PATH";
	readonly message: string;
	readonly inputPath: string;
	readonly matchedPath: string;
	readonly matchedRule: string;
	readonly phase: AccessCheckPhase;
}

export interface WorkspaceAccessPolicyOptions {
	readonly blockedPaths: readonly string[];
	readonly homeDirectory?: string;
}

/** Compiled mandatory path policy. Visibility rules deliberately do not enter this layer. */
export class WorkspaceAccessPolicy {
	private readonly rules: readonly CompiledRule[];

	constructor(options: WorkspaceAccessPolicyOptions) {
		const homeDirectory = options.homeDirectory ?? os.homedir();
		this.rules = options.blockedPaths.map((rule) => compileRule(rule, homeDirectory));
	}

	match(inputPath: string, identity: PathIdentity, phase: AccessCheckPhase): BlockedPathMatch | undefined {
		for (const rule of this.rules) {
			if (rule.path.length === 0 || !identityMatchesRule(identity, rule)) continue;
			return {
				code: "BLOCKED_PATH",
				message: "Path is blocked by filesystem policy.",
				inputPath,
				matchedPath: identity.absolutePath,
				matchedRule: rule.source,
				phase,
			};
		}
		return undefined;
	}
}

export function pathMatchesAnyRule(
	identity: PathIdentity,
	rules: readonly string[],
	homeDirectory = os.homedir(),
): boolean {
	return rules.some((rule) => identityMatchesRule(identity, compileRule(rule, homeDirectory)));
}

export function pathMatchesRule(identity: PathIdentity, rule: string, homeDirectory = os.homedir()): boolean {
	return identityMatchesRule(identity, compileRule(rule, homeDirectory));
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

function identityMatchesRule(identity: PathIdentity, rule: CompiledRule): boolean {
	const candidates = candidatePaths(identity, rule.absolute);
	return candidates.some((candidate) => matchCandidate(candidate, rule.path, rule.directory));
}

function candidatePaths(identity: PathIdentity, absoluteRule: boolean): readonly string[] {
	if (absoluteRule) return [normalizePath(identity.absolutePath)];
	const result = [normalizePath(identity.displayPath)];
	if (identity.workspacePath !== undefined) result.push(normalizePath(identity.workspacePath));
	result.push(normalizePath(identity.absolutePath));
	return [...new Set(result)];
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

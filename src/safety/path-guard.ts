import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface PathGuardConfig {
	cwd: string;
	blocked_path: string[];
}

export interface GuardedPath {
	input_path: string;
	abs_path: string;
	real_path?: string;
}

export interface PathGuardBlock {
	code: "BLOCKED_PATH";
	message: string;
	input_path: string;
	matched_path?: string;
	matched_rule?: string;
}

export interface PathIdentity {
	displayPath: string;
	absolutePath: string;
	workspacePath?: string;
}

export class PathGuardBlockedError extends Error {
	constructor(readonly block: PathGuardBlock) {
		super(block.message);
		this.name = "PathGuardBlockedError";
	}
}

export async function guardExistingPath(inputPath: string, config: PathGuardConfig): Promise<GuardedPath> {
	const absPath = resolveInputPath(config.cwd, inputPath);
	assertAllowed(inputPath, identityFor(config.cwd, inputPath, absPath), config.blocked_path);

	let realPath: string | undefined;
	try {
		realPath = await realpath(absPath);
	} catch {
		return { input_path: inputPath, abs_path: absPath };
	}
	assertAllowed(inputPath, identityFor(config.cwd, realPath, realPath), config.blocked_path);
	return { input_path: inputPath, abs_path: absPath, real_path: realPath };
}

export async function guardWritablePath(inputPath: string, config: PathGuardConfig): Promise<GuardedPath> {
	const absPath = resolveInputPath(config.cwd, inputPath);
	assertAllowed(inputPath, identityFor(config.cwd, inputPath, absPath), config.blocked_path);

	const parentRealPath = await realpathNearestExistingParent(path.dirname(absPath));
	assertAllowed(inputPath, identityFor(config.cwd, parentRealPath, parentRealPath), config.blocked_path);

	let realPath: string | undefined;
	try {
		realPath = await realpath(absPath);
	} catch {
		return { input_path: inputPath, abs_path: absPath };
	}
	assertAllowed(inputPath, identityFor(config.cwd, realPath, realPath), config.blocked_path);
	return { input_path: inputPath, abs_path: absPath, real_path: realPath };
}

export function resolveInputPath(cwd: string, inputPath: string): string {
	return path.resolve(cwd, expandHomePath(inputPath));
}

export function pathMatchesAnyRule(identity: PathIdentity, rules: readonly string[]): boolean {
	return rules.some((rule) => pathMatchesRule(identity, rule));
}

export function pathMatchesRule(identity: PathIdentity, rule: string): boolean {
	const normalizedRule = normalizeRule(rule);
	if (normalizedRule.path.length === 0) return false;
	const candidates = candidatePaths(identity, normalizedRule.absolute);
	return candidates.some((candidate) => matchCandidate(candidate, normalizedRule.path, normalizedRule.directory));
}

function assertAllowed(inputPath: string, identity: PathIdentity, rules: readonly string[]): void {
	for (const rule of rules) {
		if (!pathMatchesRule(identity, rule)) continue;
		throw new PathGuardBlockedError({
			code: "BLOCKED_PATH",
			message: "Path is blocked by file-tools config.",
			input_path: inputPath,
			matched_path: identity.absolutePath,
			matched_rule: rule,
		});
	}
}

async function realpathNearestExistingParent(parentPath: string): Promise<string> {
	let current = parentPath;
	while (true) {
		try {
			return await realpath(current);
		} catch (error) {
			if (!isNotFound(error)) throw error;
			const next = path.dirname(current);
			if (next === current) throw error;
			current = next;
		}
	}
}

function identityFor(cwd: string, displayInput: string, absolutePath: string): PathIdentity {
	const workspacePath = workspaceRelativePath(cwd, absolutePath);
	return {
		displayPath: displayPathFor(cwd, displayInput, absolutePath, workspacePath),
		absolutePath,
		...(workspacePath !== undefined ? { workspacePath } : {}),
	};
}

function displayPathFor(cwd: string, displayInput: string, absolutePath: string, workspacePath: string | undefined): string {
	if (workspacePath !== undefined) return workspacePath;
	return path.isAbsolute(expandHomePath(displayInput)) ? path.normalize(absolutePath) : normalizeRelativePath(path.relative(cwd, absolutePath));
}

function workspaceRelativePath(cwd: string, candidate: string): string | undefined {
	const relative = path.relative(path.resolve(cwd), candidate);
	if (relative === "") return ".";
	if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return normalizeRelativePath(relative);
}

function normalizeRule(rule: string): { path: string; absolute: boolean; directory: boolean } {
	const expanded = expandHomePath(rule);
	const directory = /[\\/]$/.test(expanded);
	const absolute = path.isAbsolute(expanded);
	const normalized = normalizePath(expanded).replace(/\/+$/, "");
	return { path: absolute ? normalized : normalized.replace(/^\/+/, ""), absolute, directory };
}

function candidatePaths(identity: PathIdentity, absoluteRule: boolean): string[] {
	if (absoluteRule) return [normalizePath(identity.absolutePath)];
	const result = [normalizePath(identity.displayPath)];
	if (identity.workspacePath !== undefined) result.push(normalizePath(identity.workspacePath));
	result.push(normalizePath(identity.absolutePath));
	return Array.from(new Set(result));
}

function matchCandidate(candidate: string, rule: string, directory: boolean): boolean {
	if (candidate === rule) return true;
	if (directory && candidate.startsWith(`${rule}/`)) return true;
	if (candidate.endsWith(`/${rule}`)) return true;
	return directory && candidate.includes(`/${rule}/`);
}

function expandHomePath(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function normalizePath(value: string): string {
	return path.normalize(value).replace(/\\/g, "/");
}

function normalizeRelativePath(value: string): string {
	return value === "" ? "." : value.replace(/\\/g, "/");
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

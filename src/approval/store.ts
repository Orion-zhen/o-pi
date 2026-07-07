import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import picomatch from "picomatch";
import type { ApprovalAllowRule, ApprovalRequest, PersistentApprovalRulesFile } from "./types.js";

export interface ApprovalStore {
	matchesAllowRule(request: ApprovalRequest): boolean;
	addSessionAllowRule(rule: ApprovalAllowRule): void;
	addPersistentAllowRule(rule: ApprovalAllowRule): Promise<void>;
	loadPersistentRules(): Promise<void>;
}

export class ApprovalStoreError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "ApprovalStoreError";
	}
}

export class FileApprovalStore implements ApprovalStore {
	private readonly sessionRules: ApprovalAllowRule[] = [];
	private persistentRules: ApprovalAllowRule[] = [];

	constructor(private readonly persistentStorePath: string) {}

	matchesAllowRule(request: ApprovalRequest): boolean {
		return [...this.sessionRules, ...this.persistentRules].some((rule) => allowRuleMatches(rule, request));
	}

	addSessionAllowRule(rule: ApprovalAllowRule): void {
		this.sessionRules.push(rule);
	}

	async addPersistentAllowRule(rule: ApprovalAllowRule): Promise<void> {
		this.persistentRules.push(rule);
		await this.writePersistentRules();
	}

	async loadPersistentRules(): Promise<void> {
		const filePath = expandHomePath(this.persistentStorePath);
		let text: string;
		try {
			text = await readFile(filePath, "utf8");
		} catch (error) {
			if (isNotFound(error)) {
				this.persistentRules = [];
				return;
			}
			throw new ApprovalStoreError("approval persistent rules cannot be read.", { path: filePath });
		}

		const parseErrors: ParseError[] = [];
		const parsed = parse(text, parseErrors, { allowTrailingComma: true });
		if (parseErrors.length > 0) {
			const first = parseErrors[0];
			throw new ApprovalStoreError("approval persistent rules are not valid JSONC.", {
				path: filePath,
				error: first ? printParseErrorCode(first.error) : "unknown",
				offset: first?.offset,
			});
		}
		this.persistentRules = parsePersistentRules(parsed, filePath);
	}

	private async writePersistentRules(): Promise<void> {
		const filePath = expandHomePath(this.persistentStorePath);
		await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
		const file: PersistentApprovalRulesFile = {
			version: 1,
			rules: dedupeRules(this.persistentRules),
		};
		this.persistentRules = file.rules;
		await writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	}
}

export function createExactAllowRule(request: ApprovalRequest): ApprovalAllowRule | undefined {
	const created_at = new Date().toISOString();
	if (request.tool === "bash") {
		const command = request.targets.find((target) => target.kind === "command")?.value;
		return command === undefined ? undefined : { created_at, tool: "bash", kind: "exact_command", value: command };
	}
	if (request.tool === "write" || request.tool === "edit") {
		const targetPath = request.targets.find((target) => target.kind === "path")?.value;
		return targetPath === undefined ? undefined : { created_at, tool: request.tool, kind: "exact_path", value: normalizePath(targetPath) };
	}
	return undefined;
}

export function createSimilarAllowRule(request: ApprovalRequest): ApprovalAllowRule | undefined {
	const created_at = new Date().toISOString();
	if (request.tool === "bash") {
		const command = request.targets.find((target) => target.kind === "command")?.value;
		if (command === undefined) return undefined;
		const prefix = commandPrefix(command);
		return prefix === undefined ? { created_at, tool: "bash", kind: "exact_command", value: command } : { created_at, tool: "bash", kind: "command_prefix", value: prefix };
	}
	if (request.tool === "write" || request.tool === "edit") {
		const targetPath = request.targets.find((target) => target.kind === "path")?.value;
		if (targetPath === undefined) return undefined;
		const glob = conservativePathGlob(targetPath);
		return glob === undefined
			? { created_at, tool: request.tool, kind: "exact_path", value: normalizePath(targetPath) }
			: { created_at, tool: request.tool, kind: "path_glob", value: glob };
	}
	return undefined;
}

export function describeAllowRule(rule: ApprovalAllowRule): string {
	if (rule.kind === "command_prefix") return `${rule.tool} commands starting with: ${rule.value}`;
	if (rule.kind === "exact_command") return `${rule.tool} command: ${rule.value}`;
	if (rule.kind === "path_glob") return `${rule.tool} paths matching: ${rule.value}`;
	return `${rule.tool} path: ${rule.value}`;
}

export function allowRuleMatches(rule: ApprovalAllowRule, request: ApprovalRequest): boolean {
	if (rule.tool !== request.tool) return false;
	if (rule.kind === "exact_command") {
		const command = request.targets.find((target) => target.kind === "command")?.value;
		return command === rule.value;
	}
	if (rule.kind === "command_prefix") {
		const command = request.targets.find((target) => target.kind === "command")?.value;
		return command !== undefined && (command === rule.value || command.startsWith(`${rule.value} `));
	}
	const targetPath = request.targets.find((target) => target.kind === "path")?.value;
	if (targetPath === undefined) return false;
	const normalizedTarget = normalizePath(targetPath);
	if (rule.kind === "exact_path") return normalizedTarget === normalizePath(rule.value);
	return picomatch(normalizePath(rule.value), { dot: true, nonegate: true })(normalizedTarget);
}

function parsePersistentRules(value: unknown, filePath: string): ApprovalAllowRule[] {
	if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1 || !("rules" in value) || !Array.isArray(value.rules)) {
		throw new ApprovalStoreError("approval persistent rules have invalid shape.", { path: filePath });
	}
	return value.rules.filter(isApprovalAllowRule);
}

function isApprovalAllowRule(value: unknown): value is ApprovalAllowRule {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ApprovalAllowRule>;
	return (
		typeof candidate.created_at === "string" &&
		typeof candidate.tool === "string" &&
		typeof candidate.value === "string" &&
		(candidate.kind === "exact_command" || candidate.kind === "command_prefix" || candidate.kind === "exact_path" || candidate.kind === "path_glob")
	);
}

function dedupeRules(rules: ApprovalAllowRule[]): ApprovalAllowRule[] {
	const seen = new Set<string>();
	const result: ApprovalAllowRule[] = [];
	for (const rule of rules) {
		const key = `${rule.tool}\0${rule.kind}\0${rule.value}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(rule);
	}
	return result;
}

function commandPrefix(command: string): string | undefined {
	for (const prefix of ["npm install", "pnpm install", "pip install", "uv pip install", "brew install", "git commit", "git push"]) {
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

function expandHomePath(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

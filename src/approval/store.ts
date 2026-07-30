import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import picomatch from "picomatch";

import { expandHomePath, isNotFound } from "../config-loader.js";
import type { ApprovalAllowRule, ApprovalRequest, ApprovalUnit, PersistentApprovalRulesFile } from "./types.js";

export interface ApprovalStore {
	matchesAllowRule(request: ApprovalRequest, unit: ApprovalUnit): boolean;
	addSessionAllowRules(rules: readonly ApprovalAllowRule[]): void;
	addPersistentAllowRules(rules: readonly ApprovalAllowRule[]): Promise<void>;
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
	private persistentMutation: Promise<void> = Promise.resolve();

	constructor(private readonly persistentStorePath: string) {}

	matchesAllowRule(request: ApprovalRequest, unit: ApprovalUnit): boolean {
		return this.sessionRules.some((rule) => allowRuleMatches(rule, request, unit))
			|| this.persistentRules.some((rule) => allowRuleMatches(rule, request, unit));
	}

	addSessionAllowRules(rules: readonly ApprovalAllowRule[]): void {
		this.sessionRules.push(...rules);
		dedupeRulesInPlace(this.sessionRules);
	}

	async addPersistentAllowRules(rules: readonly ApprovalAllowRule[]): Promise<void> {
		if (rules.length === 0) return;
		const mutation = this.persistentMutation.then(async () => {
			const next = dedupeRules([...this.persistentRules, ...rules]);
			await this.writePersistentRules(next);
			this.persistentRules = next;
		});
		this.persistentMutation = mutation.catch(() => {});
		await mutation;
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

	private async writePersistentRules(rules: ApprovalAllowRule[]): Promise<void> {
		const filePath = expandHomePath(this.persistentStorePath);
		await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
		const file: PersistentApprovalRulesFile = { version: 1, rules };
		await writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	}
}

export function createExactAllowRules(request: ApprovalRequest, units: readonly ApprovalUnit[]): ApprovalAllowRule[] {
	const createdAt = new Date().toISOString();
	return dedupeRules(units.flatMap((unit) => {
		if (!unit.remember.session) return [];
		return allowRuleForTarget(request, unit, createdAt, "exact");
	}));
}

export function createSimilarAllowRules(request: ApprovalRequest, units: readonly ApprovalUnit[]): ApprovalAllowRule[] {
	const createdAt = new Date().toISOString();
	return dedupeRules(units.flatMap((unit) => {
		if (!unit.remember.persistent) return [];
		return allowRuleForTarget(request, unit, createdAt, "similar");
	}));
}

export function describeAllowRules(rules: readonly ApprovalAllowRule[]): string {
	return rules.map(describeAllowRule).join("; ");
}

function describeAllowRule(rule: ApprovalAllowRule): string {
	const scope = rule.cwd === undefined ? "" : ` in ${rule.cwd}`;
	if (rule.kind === "command_prefix") return `${rule.tool} commands starting with: ${rule.value}${scope}`;
	if (rule.kind === "exact_command") return `${rule.tool} command: ${rule.value}${scope}`;
	if (rule.kind === "path_glob") return `${rule.tool} paths matching: ${rule.value}`;
	return `${rule.tool} path: ${rule.value}`;
}

export function allowRuleMatches(rule: ApprovalAllowRule, request: ApprovalRequest, unit: ApprovalUnit): boolean {
	if (rule.tool !== request.tool) return false;
	if (rule.cwd !== undefined && normalizePath(rule.cwd) !== normalizePath(request.cwd)) return false;
	if (rule.kind === "exact_command") {
		return unit.target.kind === "command" && unit.target.value === rule.value;
	}
	if (rule.kind === "command_prefix") {
		if (unit.target.kind !== "command") return false;
		const command = unit.target.similar_value ?? unit.target.match_value ?? unit.target.value;
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
	createdAt: string,
	mode: "exact" | "similar",
): ApprovalAllowRule[] {
	if (unit.target.kind === "command") {
		const prefix = mode === "similar"
			? commandPrefix(unit.target.similar_value ?? unit.target.match_value ?? unit.target.value)
			: undefined;
		return [{
			created_at: createdAt,
			tool: request.tool,
			kind: prefix === undefined ? "exact_command" : "command_prefix",
			value: prefix ?? unit.target.value,
			cwd: request.cwd,
		}];
	}
	if (unit.target.kind !== "path") return [];
	const normalized = normalizePath(unit.target.value);
	const glob = mode === "similar" ? conservativePathGlob(normalized) : undefined;
	return [{
		created_at: createdAt,
		tool: request.tool,
		kind: glob === undefined ? "exact_path" : "path_glob",
		value: glob ?? normalized,
	}];
}

function parsePersistentRules(value: unknown, filePath: string): ApprovalAllowRule[] {
	if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1 || !("rules" in value) || !Array.isArray(value.rules)) {
		throw new ApprovalStoreError("approval persistent rules have invalid shape.", { path: filePath });
	}
	return dedupeRules(value.rules.filter(isApprovalAllowRule));
}

function isApprovalAllowRule(value: unknown): value is ApprovalAllowRule {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ApprovalAllowRule>;
	return (
		typeof candidate.created_at === "string" &&
		typeof candidate.tool === "string" &&
		typeof candidate.value === "string" &&
		(candidate.cwd === undefined || typeof candidate.cwd === "string") &&
		(candidate.kind === "exact_command" || candidate.kind === "command_prefix" || candidate.kind === "exact_path" || candidate.kind === "path_glob")
	);
}

function dedupeRulesInPlace(rules: ApprovalAllowRule[]): void {
	const deduped = dedupeRules(rules);
	rules.splice(0, rules.length, ...deduped);
}

function dedupeRules(rules: readonly ApprovalAllowRule[]): ApprovalAllowRule[] {
	const seen = new Set<string>();
	const result: ApprovalAllowRule[] = [];
	for (const rule of rules) {
		const key = `${rule.tool}\0${rule.kind}\0${rule.value}\0${rule.cwd ?? ""}`;
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

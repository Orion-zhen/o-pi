import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import { expandHomePath, isNotFound } from "../../config-loader.js";
import type { ApprovalAllowRule, ApprovalRequest, ApprovalUnit } from "../types.js";
import { allowRuleMatches, dedupeRules, type ApprovalRuleMatcher } from "./allow.js";

export interface ApprovalStore extends ApprovalRuleMatcher {
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
			if (isNotFound(error)) return;
			throw error;
		}

		const parseErrors: ParseError[] = [];
		const parsed = parse(text, parseErrors, { allowTrailingComma: true });
		const firstParseError = parseErrors.at(0);
		if (firstParseError !== undefined) {
			throw new ApprovalStoreError("approval persistent rules are not valid JSONC.", {
				path: filePath,
				error: printParseErrorCode(firstParseError.error),
				offset: firstParseError.offset,
			});
		}
		this.persistentRules = parsePersistentRules(parsed, filePath);
	}

	private async writePersistentRules(rules: ApprovalAllowRule[]): Promise<void> {
		const filePath = expandHomePath(this.persistentStorePath);
		await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
		await writeFile(filePath, `${JSON.stringify({ rules }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	}
}

function parsePersistentRules(value: unknown, filePath: string): ApprovalAllowRule[] {
	if (typeof value !== "object" || value === null || !("rules" in value) || !Array.isArray(value.rules)) {
		throw new ApprovalStoreError("approval persistent rules have invalid shape.", { path: filePath });
	}
	const rules: ApprovalAllowRule[] = [];
	for (const candidate of value.rules) {
		const rule = parseApprovalAllowRule(candidate);
		if (rule !== undefined) rules.push(rule);
	}
	return dedupeRules(rules);
}

function parseApprovalAllowRule(value: unknown): ApprovalAllowRule | undefined {
	if (
		typeof value !== "object"
		|| value === null
		|| !("tool" in value)
		|| (value.tool !== "bash" && value.tool !== "write" && value.tool !== "edit" && value.tool !== "webfetch")
		|| !("kind" in value)
		|| !("value" in value)
		|| typeof value.value !== "string"
	) return undefined;
	if (value.kind === "exact_command" || value.kind === "command_prefix") {
		if (!("cwd" in value) || typeof value.cwd !== "string") return undefined;
		return { tool: value.tool, kind: value.kind, value: value.value, cwd: value.cwd };
	}
	if ((value.kind === "exact_path" || value.kind === "path_glob" || value.kind === "exact_url") && !("cwd" in value)) {
		return { tool: value.tool, kind: value.kind, value: value.value };
	}
	return undefined;
}

function dedupeRulesInPlace(rules: ApprovalAllowRule[]): void {
	const deduped = dedupeRules(rules);
	rules.splice(0, rules.length, ...deduped);
}

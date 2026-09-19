import { mkdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { isNotFound } from "../../config-loader.ts";
import type { ApprovalAllowRule } from "../types.ts";
import { allowRuleMatches, dedupeRules, type ApprovalRuleMatcher } from "./allow.ts";

export interface ApprovalStore extends ApprovalRuleMatcher {
	addSessionAllowRules(rules: readonly ApprovalAllowRule[]): void;
	addPersistentAllowRules(rules: readonly ApprovalAllowRule[]): Promise<void>;
}

/** 临时授权属于逻辑会话，不随 SDK 实例回收。 */
export class SessionApprovalRules {
	rules: ApprovalAllowRule[] = [];
}

/** 宿主共享持久规则及写入队列，会话授权仍分别保存。 */
export class ApprovalStores {
	private files = new Map<string, Promise<FileApprovalStore>>();
	open(file: string): Promise<FileApprovalStore> {
		const key = path.resolve(file);
		let pending = this.files.get(key);
		if (!pending) {
			pending = FileApprovalStore.open(key).catch((error: unknown) => {
				this.files.delete(key);
				throw error;
			});
			this.files.set(key, pending);
		}
		return pending;
	}
}

export class FileApprovalStore {
	private persistentRules: ApprovalAllowRule[] = [];
	private stamp: string | undefined;
	private persistentMutation: Promise<void> = Promise.resolve();
	private constructor(private readonly persistentStorePath: string) {}

	static async open(persistentStorePath: string): Promise<FileApprovalStore> {
		const store = new FileApprovalStore(persistentStorePath);
		await store.loadPersistentRules();
		return store;
	}

	forSession(session: SessionApprovalRules): ApprovalStore {
		return {
			matchesAllowRule: (request, unit) => session.rules.some((rule) => allowRuleMatches(rule, request, unit))
				|| this.persistentRules.some((rule) => allowRuleMatches(rule, request, unit)),
			addSessionAllowRules: (rules) => { session.rules = dedupeRules([...session.rules, ...rules]); },
			addPersistentAllowRules: (rules) => this.addPersistentAllowRules(rules),
		};
	}


	refresh(): Promise<void> {
		const operation = this.persistentMutation.then(() => this.loadPersistentRules());
		this.persistentMutation = operation.catch(() => {});
		return operation;
	}

	async addPersistentAllowRules(rules: readonly ApprovalAllowRule[]): Promise<void> {
		if (rules.length === 0) return;
		const mutation = this.persistentMutation.then(async () => {
			await this.loadPersistentRules();
			const next = dedupeRules([...this.persistentRules, ...rules]);
			await this.writePersistentRules(next);
			this.persistentRules = next;
			this.stamp = undefined;
		});
		this.persistentMutation = mutation.catch(() => {});
		await mutation;
	}

	private async loadPersistentRules(): Promise<void> {
		let metadata;
		try { metadata = await stat(this.persistentStorePath); }
		catch (error) {
			if (!isNotFound(error)) throw error;
			this.persistentRules = []; this.stamp = undefined;
			return;
		}
		const stamp = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
		if (stamp === this.stamp) return;
		const text = await readFile(this.persistentStorePath, "utf8");
		const errors: ParseError[] = [];
		const parsed: unknown = parse(text, errors, { allowTrailingComma: true });
		const first = errors.at(0);
		if (first) throw new Error(`approval persistent rules are not valid JSONC: ${printParseErrorCode(first.error)}`);
		this.persistentRules = parsePersistentRules(parsed);
		this.stamp = stamp;
	}

	private async writePersistentRules(rules: ApprovalAllowRule[]): Promise<void> {
		const file = this.persistentStorePath;
		await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify({ rules }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
			await rename(temporary, file);
		} finally { await rm(temporary, { force: true }); }
	}
}

function parsePersistentRules(value: unknown): ApprovalAllowRule[] {
	if (typeof value !== "object" || value === null || !("rules" in value) || !Array.isArray(value.rules))
		throw new Error("approval persistent rules have invalid shape.");
	const rules: ApprovalAllowRule[] = [];
	for (const candidate of value.rules) {
		const rule = parseApprovalAllowRule(candidate);
		if (rule !== undefined) rules.push(rule);
	}
	return dedupeRules(rules);
}

function parseApprovalAllowRule(value: unknown): ApprovalAllowRule | undefined {
	if (typeof value !== "object" || value === null || !("tool" in value)
		|| (value.tool !== "bash" && value.tool !== "write" && value.tool !== "edit" && value.tool !== "webfetch")
		|| !("kind" in value) || !("value" in value) || typeof value.value !== "string") return undefined;
	if (value.kind === "exact_command" || value.kind === "command_prefix") {
		if (!("cwd" in value) || typeof value.cwd !== "string") return undefined;
		return { tool: value.tool, kind: value.kind, value: value.value, cwd: value.cwd };
	}
	if ((value.kind === "exact_path" || value.kind === "path_glob" || value.kind === "exact_url") && !("cwd" in value))
		return { tool: value.tool, kind: value.kind, value: value.value };
	return undefined;
}

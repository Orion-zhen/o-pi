import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type ValidateFunction } from "ajv/dist/ajv.js";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { ApprovalGateConfig, ApprovalRule } from "./types.js";

const CONFIG_PATH_ENV = "PI_APPROVAL_GATE_CONFIG";

const defaultConfig: ApprovalGateConfig = {
	version: 1,
	enabled: true,
	ui: {
		timeout_ms: 0,
		non_interactive: "block",
	},
	remember: {
		allow_session: true,
		allow_persistent: true,
		persistent_store: "~/.pi/agent/state/approval-gate.rules.jsonc",
	},
	defaults: {
		bash: "allow",
		write: "allow",
		edit: "allow",
	},
	ask_rules: [
		{
			name: "system-path-write",
			tools: ["write", "edit"],
			path_globs: ["/etc/**", "/usr/**", "/bin/**", "/sbin/**", "/System/**", "/Library/**", "/var/**"],
			reason: "system path modification",
		},
		{
			name: "destructive-bash",
			tools: ["bash"],
			command_regex: "\\b(rm\\s+-rf|git\\s+reset\\s+--hard|git\\s+clean\\s+-fd|docker\\s+system\\s+prune)\\b",
			reason: "destructive command",
		},
		{
			name: "package-management",
			tools: ["bash"],
			command_regex: "\\b(apt|dnf|yum|pacman|brew|npm|pnpm|pip|uv|cargo)\\b[\\s\\S]*\\b(install|remove|uninstall|upgrade|update)\\b",
			reason: "package management",
		},
		{
			name: "external-publish",
			tools: ["bash"],
			command_regex: "\\b(git\\s+push|npm\\s+publish|gh\\s+release|twine\\s+upload)\\b",
			reason: "external publishing",
		},
		{
			name: "service-management",
			tools: ["bash"],
			command_regex: "\\b(sudo|systemctl|service|launchctl)\\b",
			reason: "system-level command",
		},
		{
			name: "infra-side-effect",
			tools: ["bash"],
			command_regex: "\\b(kubectl\\s+(apply|delete)|terraform\\s+(apply|destroy)|docker\\s+(rm|prune|system\\s+prune))\\b",
			reason: "infrastructure side effect",
		},
	],
	deny_rules: [],
};

let compiledValidator: ValidateFunction | undefined;

export class ApprovalConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "ApprovalConfigError";
	}
}

export async function loadApprovalGateConfig(): Promise<ApprovalGateConfig> {
	const configPath = resolveConfigPath();
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		if (isNotFound(error)) return defaultApprovalGateConfig();
		throw new ApprovalConfigError("approval-gate config cannot be read.", { path: configPath });
	}

	const parseErrors: ParseError[] = [];
	const parsed = parse(text, parseErrors, { allowTrailingComma: true });
	if (parseErrors.length > 0) {
		const first = parseErrors[0];
		throw new ApprovalConfigError("approval-gate config is not valid JSONC.", {
			path: configPath,
			error: first ? printParseErrorCode(first.error) : "unknown",
			offset: first?.offset,
		});
	}

	const validator = await loadValidator();
	if (!validator(parsed)) {
		throw new ApprovalConfigError("approval-gate config does not match schema.", {
			path: configPath,
			errors: validator.errors ?? [],
		});
	}

	return mergeConfig(parsed as RawApprovalGateConfig);
}

export function defaultApprovalGateConfig(): ApprovalGateConfig {
	return {
		version: 1,
		enabled: defaultConfig.enabled,
		ui: { ...defaultConfig.ui },
		remember: { ...defaultConfig.remember },
		defaults: { ...defaultConfig.defaults },
		ask_rules: cloneRules(defaultConfig.ask_rules),
		deny_rules: [],
	};
}

interface RawApprovalGateConfig {
	version: 1;
	enabled?: boolean;
	ui?: Partial<ApprovalGateConfig["ui"]>;
	remember?: Partial<ApprovalGateConfig["remember"]>;
	defaults?: Record<string, ApprovalGateConfig["defaults"][string]>;
	ask_rules?: ApprovalRule[];
	deny_rules?: ApprovalRule[];
}

function mergeConfig(raw: RawApprovalGateConfig): ApprovalGateConfig {
	const merged: ApprovalGateConfig = {
		version: 1,
		enabled: raw.enabled ?? defaultConfig.enabled,
		ui: {
			timeout_ms: raw.ui?.timeout_ms ?? defaultConfig.ui.timeout_ms,
			non_interactive: raw.ui?.non_interactive ?? defaultConfig.ui.non_interactive,
		},
		remember: {
			allow_session: raw.remember?.allow_session ?? defaultConfig.remember.allow_session,
			allow_persistent: raw.remember?.allow_persistent ?? defaultConfig.remember.allow_persistent,
			persistent_store: expandHomePath(raw.remember?.persistent_store ?? defaultConfig.remember.persistent_store),
		},
		defaults: raw.defaults ?? { ...defaultConfig.defaults },
		ask_rules: cloneRules(raw.ask_rules ?? defaultConfig.ask_rules),
		deny_rules: cloneRules(raw.deny_rules ?? defaultConfig.deny_rules),
	};
	validateRules([...merged.ask_rules, ...merged.deny_rules]);
	return merged;
}

function validateRules(rules: ApprovalRule[]): void {
	for (const rule of rules) {
		if (rule.command_regex === undefined) continue;
		try {
			new RegExp(rule.command_regex, "u");
		} catch (error) {
			throw new ApprovalConfigError("approval rule command_regex contains an invalid regular expression.", {
				rule: rule.name,
				command_regex: rule.command_regex,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

function cloneRules(rules: ApprovalRule[]): ApprovalRule[] {
	return rules.map((rule) => ({
		name: rule.name,
		tools: [...rule.tools],
		...(rule.path_globs !== undefined ? { path_globs: [...rule.path_globs] } : {}),
		...(rule.command_regex !== undefined ? { command_regex: rule.command_regex } : {}),
		...(rule.effects !== undefined ? { effects: [...rule.effects] } : {}),
		reason: rule.reason,
	}));
}

async function loadValidator(): Promise<ValidateFunction> {
	if (compiledValidator !== undefined) return compiledValidator;
	const schemaPath = path.join(projectRoot(), "agent", "schemas", "approval-gate.schema.json");
	let schema: object;
	try {
		schema = JSON.parse(await readFile(schemaPath, "utf8")) as object;
	} catch {
		throw new ApprovalConfigError("approval-gate schema cannot be read.", { path: schemaPath });
	}
	const ajv = new Ajv({ allErrors: true, strict: true, validateSchema: false });
	compiledValidator = ajv.compile(schema);
	return compiledValidator;
}

function resolveConfigPath(): string {
	return process.env[CONFIG_PATH_ENV] ?? path.join(projectRoot(), "agent", "configs", "approval-gate.jsonc");
}

function projectRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function expandHomePath(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

import { agentConfigPath, agentSchemaPath, createSchemaValidator, expandHomePath, readOptionalJsoncConfigWithSchema } from "../config-loader.js";
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

export class ApprovalConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
		this.name = "ApprovalConfigError";
	}
}

export async function loadApprovalGateConfig(): Promise<ApprovalGateConfig> {
	const configPath = resolveConfigPath();
	const parsed = await readOptionalJsoncConfigWithSchema({
		path: configPath,
		label: "approval-gate",
		loadValidator,
		createError: (message, details) => new ApprovalConfigError(message, details),
	});
	if (parsed === undefined) return defaultApprovalGateConfig();
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

const loadValidator = createSchemaValidator({
	schemaPath: agentSchemaPath("approval-gate.schema.json"),
	label: "approval-gate",
	createError: (message, details) => new ApprovalConfigError(message, details),
});

function resolveConfigPath(): string {
	return agentConfigPath("approval-gate.jsonc", CONFIG_PATH_ENV);
}

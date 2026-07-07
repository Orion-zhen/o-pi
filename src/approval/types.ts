export type ApprovalEffect =
	| "read"
	| "write"
	| "delete"
	| "execute"
	| "network"
	| "install"
	| "publish"
	| "system_change"
	| "external_side_effect"
	| "destructive"
	| "unknown_side_effect";

export interface ApprovalTarget {
	kind: "path" | "command" | "url" | "package" | "service" | "other";
	value: string;
}

export interface ApprovalRequest {
	id: string;
	tool: string;
	action: string;
	summary: string;
	subject: string;
	targets: ApprovalTarget[];
	effects: ApprovalEffect[];
	raw_input: unknown;
}

export type ApprovalDecision =
	| { kind: "allow" }
	| { kind: "ask"; reason: string; rule_name?: string }
	| { kind: "deny"; reason: string; rule_name?: string };

export type UserApprovalChoice =
	| { kind: "allow_once" }
	| { kind: "allow_session" }
	| { kind: "allow_persistent" }
	| { kind: "deny" }
	| { kind: "deny_with_instruction"; instruction: string };

export type ApprovalDefaultAction = "allow" | "ask" | "deny";

export interface ApprovalRule {
	name: string;
	tools: string[];
	path_globs?: string[];
	command_regex?: string;
	effects?: ApprovalEffect[];
	reason: string;
}

export interface ApprovalGateConfig {
	version: 1;
	enabled: boolean;
	ui: {
		timeout_ms: number;
		non_interactive: "block" | "allow";
	};
	remember: {
		allow_session: boolean;
		allow_persistent: boolean;
		persistent_store: string;
	};
	defaults: Record<string, ApprovalDefaultAction>;
	ask_rules: ApprovalRule[];
	deny_rules: ApprovalRule[];
}

export type ApprovalAllowRuleKind = "exact_command" | "command_prefix" | "exact_path" | "path_glob";

export interface ApprovalAllowRule {
	created_at: string;
	tool: string;
	kind: ApprovalAllowRuleKind;
	value: string;
}

export interface PersistentApprovalRulesFile {
	version: 1;
	rules: ApprovalAllowRule[];
}

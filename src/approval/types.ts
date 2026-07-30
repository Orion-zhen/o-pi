export interface ApprovalTelemetry {
	decision: "allow" | "deny" | "ask";
	outcome:
		| "not_required"
		| "gate_disabled"
		| "policy_allow"
		| "policy_deny"
		| "safety_block"
		| "non_interactive_allow"
		| "non_interactive_block"
		| "allow_once"
		| "allow_session"
		| "allow_persistent"
		| "deny"
		| "deny_with_instruction"
		| "dismissed";
	wait_ms: number;
	rule_name?: string;
}

export type ApprovalTelemetryObserver = (toolCallId: string, toolName: string, approval: ApprovalTelemetry) => void;

export interface ApprovalTarget {
	kind: "path" | "command" | "url" | "package" | "service" | "other";
	/** 用于展示和精确批准匹配的规范值。 */
	value: string;
	/** 仅供策略 matcher 使用；例如移除外层命令中的嵌套 substitution。 */
	match_value?: string;
	/** 仅供保守 similar matcher 使用；例如跳过 env wrapper。 */
	similar_value?: string;
}

export interface ApprovalUnit {
	action: string;
	target: ApprovalTarget;
	remember: {
		session: boolean;
		persistent: boolean;
	};
}

export interface ApprovalRequest {
	tool: string;
	cwd: string;
	summary: string;
	units: ApprovalUnit[];
}

export interface ApprovalAskItem {
	unit: ApprovalUnit;
	reason: string;
	rule_name?: string;
}

export type ApprovalDecision =
	| { kind: "allow" }
	| { kind: "ask"; reason: string; items: ApprovalAskItem[]; rule_name?: string }
	| { kind: "deny"; reason: string; rule_name?: string };

export type ApprovalDefaultAction = "allow" | "ask" | "deny";

export interface ApprovalRule {
	name: string;
	tools: string[];
	path_globs?: string[];
	command_regex?: string;
	reason: string;
}

export interface ApprovalGateConfig {
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
	/** 新规则按工作目录隔离；缺失表示兼容已有全局规则。 */
	cwd?: string;
}

export interface PersistentApprovalRulesFile {
	version: 1;
	rules: ApprovalAllowRule[];
}

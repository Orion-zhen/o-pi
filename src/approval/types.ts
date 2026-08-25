export type ApprovalTarget =
	| {
		kind: "command";
		/** 用于展示和精确批准匹配的规范值。 */
		value: string;
		/** 仅供策略 matcher 使用；例如移除外层命令中的嵌套 substitution。 */
		match_value: string;
		/** 仅供保守 similar matcher 使用；例如跳过 env wrapper。 */
		similar_value?: string;
	}
	| {
		kind: "path";
		/** 用于展示和精确批准匹配的规范值。 */
		value: string;
	};

export interface ApprovalUnit {
	action: "execute" | "write_redirect" | "write_file" | "edit_file";
	target: ApprovalTarget;
	/** 已静态证明副作用不会逃逸一次性临时目录时，无需交互确认。 */
	effect_scope?: "temporary";
	remember: {
		session: boolean;
		persistent: boolean;
	};
}

export interface ApprovalEditReplacement {
	old: string;
	new: string;
	replace_all?: boolean;
}

export type ApprovalRequestDetail =
	| { kind: "bash"; command: string }
	| { kind: "write"; path: string; content: string }
	| { kind: "edit"; path: string; edits: ApprovalEditReplacement[] };

interface ApprovalRequestBase {
	cwd: string;
	summary: string;
	units: ApprovalUnit[];
}

export interface BashApprovalRequest extends ApprovalRequestBase {
	tool: "bash";
	detail: Extract<ApprovalRequestDetail, { kind: "bash" }>;
}

export interface WriteApprovalRequest extends ApprovalRequestBase {
	tool: "write";
	detail: Extract<ApprovalRequestDetail, { kind: "write" }>;
}

export interface EditApprovalRequest extends ApprovalRequestBase {
	tool: "edit";
	detail: Extract<ApprovalRequestDetail, { kind: "edit" }>;
}

export type ApprovalRequest = BashApprovalRequest | WriteApprovalRequest | EditApprovalRequest;

export interface ApprovalAskItem {
	unit: ApprovalUnit;
	reason: string;
}

export type ApprovalDecision =
	| { kind: "allow" }
	| { kind: "ask"; reason: string; items: ApprovalAskItem[] }
	| { kind: "deny"; reason: string; rule_name?: string };

export type ApprovalDefaultAction = "allow" | "ask" | "deny";
export type BashPolicyMatchScope = "raw-input" | "source-unit" | "effective-unit";
export type BashPolicyPlatform = "linux" | "darwin" | "win32";

export interface BashPolicyCommandMatcher {
	regex: string;
	scope?: BashPolicyMatchScope;
	platform?: BashPolicyPlatform;
}

export type BashPolicyCommandRule = string | false | BashPolicyCommandMatcher;

export interface BashPolicyFact {
	enabled?: boolean;
	action?: Exclude<ApprovalDefaultAction, "allow">;
	commands: Record<string, BashPolicyCommandRule>;
}

export interface BashPolicyCombination {
	enabled?: boolean;
	all: string[];
	action: Exclude<ApprovalDefaultAction, "allow">;
}

export interface BashPolicyConfig {
	default_action: ApprovalDefaultAction;
	facts: Record<string, BashPolicyFact>;
	combinations: Record<string, BashPolicyCombination | false>;
}

export interface ApprovalRule {
	name: string;
	tools: string[];
	path_globs?: string[];
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
	tools: {
		bash: BashPolicyConfig;
		write: { default_action: ApprovalDefaultAction };
		edit: { default_action: ApprovalDefaultAction };
	};
	ask_rules: ApprovalRule[];
	deny_rules: ApprovalRule[];
}

export type ApprovalAllowRule =
	| {
		tool: ApprovalRequest["tool"];
		kind: "exact_command" | "command_prefix";
		value: string;
		cwd: string;
	}
	| {
		tool: ApprovalRequest["tool"];
		kind: "exact_path" | "path_glob";
		value: string;
	};

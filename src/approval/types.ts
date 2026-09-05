type ApprovalTarget =
	| {
		kind: "command";
		/** 用于展示和精确批准匹配的规范值。 */
		value: string;
		/** 解包后的命令，用于策略和保守前缀匹配。 */
		effective_value: string;
	}
	| {
		kind: "path";
		/** 用于展示和精确批准匹配的规范值。 */
		value: string;
	}
	| {
		kind: "url";
		/** 内网审批按 origin 匹配，不将路径或查询参数扩大为持久规则。 */
		value: string;
	};

export interface ApprovalUnit {
	action: "execute" | "write_redirect" | "write_file" | "edit_file" | "fetch_url";
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

export type ApprovalRequest = {
	cwd: string;
	units: ApprovalUnit[];
} & (
	| { tool: "bash"; detail: { command: string } }
	| { tool: "write"; detail: { path: string; content: string } }
	| { tool: "edit"; detail: { path: string; edits: ApprovalEditReplacement[] } }
	| {
		tool: "webfetch";
		detail: {
			url: string;
			origin: string;
			addresses: import("../web-tools/network/network-policy.js").ResolvedAddresses;
		};
	}
);

export type BashApprovalRequest = Extract<ApprovalRequest, { tool: "bash" }>;

interface ApprovalAskItem {
	unit: ApprovalUnit;
	reason: string;
}

export type ApprovalDecision =
	| { kind: "allow" }
	| { kind: "ask"; reason: string; items: ApprovalAskItem[] }
	| { kind: "deny"; reason: string; rule_name?: string };

type ApprovalDefaultAction = "allow" | "ask" | "deny";
type BashPolicyMatchScope = "raw-input" | "source-unit" | "effective-unit";
type BashPolicyPlatform = "linux" | "darwin" | "win32";

export interface BashPolicyCommandMatcher {
	classifier: string;
	regex: RegExp;
	scope: BashPolicyMatchScope;
	platform?: BashPolicyPlatform;
}

export interface BashPolicyFact {
	action?: Exclude<ApprovalDefaultAction, "allow">;
	commands: BashPolicyCommandMatcher[];
}

export interface BashPolicyCombination {
	all: string[];
	action: Exclude<ApprovalDefaultAction, "allow">;
}

export interface BashPolicyConfig {
	default_action: ApprovalDefaultAction;
	facts: Record<string, BashPolicyFact>;
	combinations: Record<string, BashPolicyCombination>;
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
		webfetch: { default_action: ApprovalDefaultAction };
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
	}
	| {
		tool: ApprovalRequest["tool"];
		kind: "exact_url";
		value: string;
	};

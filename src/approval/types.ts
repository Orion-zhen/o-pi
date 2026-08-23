export type ApprovalTarget =
	| {
		kind: "command";
		/** 用于展示和精确批准匹配的规范值。 */
		value: string;
		/** 仅供策略 matcher 使用；例如移除外层命令中的嵌套 substitution。 */
		match_value?: string;
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

export interface ApprovalRequest {
	tool: "bash" | "write" | "edit";
	cwd: string;
	summary: string;
	detail: ApprovalRequestDetail;
	units: ApprovalUnit[];
}

export interface ApprovalAskItem {
	unit: ApprovalUnit;
	reason: string;
}

export type ApprovalDecision =
	| { kind: "allow" }
	| { kind: "ask"; reason: string; items: ApprovalAskItem[] }
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

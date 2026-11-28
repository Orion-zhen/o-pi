import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { EditParams } from "../file-tools/edit/types.ts";
import type { WriteParams } from "../file-tools/write/types.ts";
import type { ShellName } from "../shell-runtime/platform.ts";
import type { NetworkScope } from "../web-tools/network/network-policy.ts";

export interface NumericFileName {
	prefix: string;
	suffix: string;
}

type ApprovalTarget =
	| {
		kind: "command";
		/** 用于展示和精确批准匹配的规范值。 */
		value: string;
	}
	| {
		kind: "path";
		/** 仅确定 Bash 绝对路径，未知其 Windows 宿主映射。 */
		unmapped?: true;
		/** 文件名不确定时记录父目录，此时 value 仅用于展示。 */
		directory?: string;
		numericName?: NumericFileName;
		guidPrefix?: string;
		value: string;
	}
	| {
		kind: "url";
		/** 网络审批以 origin 为目标。 */
		value: string;
	};

/** 未知参数保留源词，不作为字面值。 */
export type ShellArg = string | { source: string; singleField?: true; unresolved?: true; guidPrefix?: string; elements?: readonly string[] };
export type ShellArgv = readonly [program: string, ...args: ShellArg[]];

export interface ShellPipeline {
	unit: ApprovalUnit;
	/** 每个阶段可有多组静态展开结果。 */
	stages: ShellArgv[][];
}

export interface ApprovalUnit {
	commands?: ShellArgv[];
	analysisFact?: "shell.run-opaque-input" | "system.disrupt-host";
	analysisNote?: string;
	/** 顶层源表达式。嵌套脚本可能已展开敏感值，不作为脱敏展示来源。 */
	source?: string;
	action: "execute" | "write_redirect" | "create_directory" | "write_file" | "edit_file" | "fetch_url";
	target: ApprovalTarget;
	/** 已证明脚本无法执行或副作用仅限临时目录，无需交互确认。 */
	effect_scope?: "none" | "temporary";
	remember: boolean;
}

export interface WebFetchTarget {
	scope: NetworkScope;
	url: string;
	redacted: boolean;
	origin: string;
	addresses: readonly string[];
}

export interface ShellApprovalRequest {
	tool: ShellName;
	cwd: string;
	units: ApprovalUnit[];
	pipelines: ShellPipeline[];
	allowSessionMemory: boolean;
	detail: { command: string; environment?: Readonly<Record<string, string | null>> };
}

export type TargetApprovalDetails = { cwd: string } & (
	| { tool: "write"; detail: WriteParams }
	| { tool: "edit"; detail: EditParams }
	| { tool: "webfetch"; detail: WebFetchTarget }
);

export type SingleTargetRequest = TargetApprovalDetails & { unit: ApprovalUnit };
export type ApprovalRequest = ShellApprovalRequest | SingleTargetRequest;

interface ApprovalAskItem {
	unit: ApprovalUnit;
	reason: string;
}

export type ApprovalDecision =
	| { kind: "allow" }
	| { kind: "ask"; reason: string; items: ApprovalAskItem[] }
	| { kind: "deny"; reason: string; rule_name?: string };

type ApprovalDefaultAction = "allow" | "ask" | "deny";

export type ShellCommandPrefix = readonly [program: string, ...args: string[]];

/** directory 是配置加载时解析的字面目录，不参与 glob 匹配。 */
export interface PathGlob {
	pattern: string;
	directory?: string;
}

export type ShellScope = { shell?: ShellName };

export type CommandRule<G = PathGlob> = { command: ShellCommandPrefix; except?: ShellCommandPrefix[] } & (
	| { exact: true; arg_globs?: never }
	| { exact?: false; arg_globs?: G[] }
);

export type ShellPolicyCommandMatcher = ShellScope & { classifier: string } & (CommandRule | { pipeline: CommandRule[] });

type RuleAction = { action: "ask" | "deny"; reason: string };

export type FileFact<G = PathGlob> = RuleAction & ({ path_globs: G[] } | { match_all: true });
export type NetworkFact = RuleAction & ({ network_scope: WebFetchTarget["scope"] } | { match_all: true });

export type ShellFactSettings<G = PathGlob> = (RuleAction | { action?: never; reason?: string }) & ShellScope & {
	path_globs?: G[];
	match_all?: true;
};

export type ShellPolicyFact = ShellFactSettings & { commands: ShellPolicyCommandMatcher[] };
export type ShellPolicyCombination = RuleAction & ShellScope & { all: string[] };

export interface ToolPolicy<F> {
	default_action: ApprovalDefaultAction;
	facts: Record<string, F>;
}

export interface ShellPolicyConfig extends ToolPolicy<ShellPolicyFact> {
	combinations: Record<string, ShellPolicyCombination>;
}

export interface ApprovalGateConfig {
	enabled: boolean;
	ai_review: {
		enabled: boolean;
		model: string | null;
		thinking_level: ModelThinkingLevel;
		auto_apply_seconds: number;
		max_turns: number;
		max_tool_calls: number;
	};
	ui: {
		timeout_ms: number;
		non_interactive: "block" | "allow";
	};
	tools: {
		shell: ShellPolicyConfig;
		write: ToolPolicy<FileFact>;
		edit: ToolPolicy<FileFact>;
		webfetch: ToolPolicy<NetworkFact>;
	};
}

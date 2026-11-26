import type { EditParams } from "../file-tools/edit/types.ts";
import type { WriteParams } from "../file-tools/write/types.ts";
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
		/** 文件名不确定时记录父目录，此时 value 仅用于展示。 */
		directory?: string;
		numericName?: NumericFileName;
		value: string;
	}
	| {
		kind: "url";
		/** 网络审批以 origin 为目标。 */
		value: string;
	};

/** 未知参数保留源词，不作为字面值。 */
export type BashArg = string | { source: string };
export type BashArgv = readonly [program: string, ...args: BashArg[]];

export interface BashPipeline {
	unit: ApprovalUnit;
	/** 每个阶段可有多组静态展开结果。 */
	stages: BashArgv[][];
}

export interface ApprovalUnit {
	commands?: BashArgv[];
	analysisFact?: "execution.opaque" | "system.catastrophic";
	/** 顶层源表达式。嵌套脚本可能已展开敏感值，不作为脱敏展示来源。 */
	source?: string;
	action: "execute" | "write_redirect" | "write_file" | "edit_file" | "fetch_url";
	target: ApprovalTarget;
	/** 已静态证明副作用不会逃逸一次性临时目录时，无需交互确认。 */
	effect_scope?: "temporary";
	remember: boolean;
}

export interface WebFetchTarget {
	scope: NetworkScope;
	url: string;
	origin: string;
	addresses: readonly string[];
}

export interface BashApprovalRequest {
	tool: "bash";
	cwd: string;
	units: ApprovalUnit[];
	pipelines: BashPipeline[];
	allowSessionMemory: boolean;
	detail: { command: string; environment?: Readonly<Record<string, string | null>> };
}

export type SingleTargetRequest = { cwd: string; unit: ApprovalUnit } & (
	| { tool: "write"; detail: WriteParams }
	| { tool: "edit"; detail: EditParams }
	| { tool: "webfetch"; detail: WebFetchTarget }
);

export type ApprovalRequest = BashApprovalRequest | SingleTargetRequest;

interface ApprovalAskItem {
	unit: ApprovalUnit;
	reason: string;
}

export type ApprovalDecision =
	| { kind: "allow" }
	| { kind: "ask"; reason: string; items: ApprovalAskItem[] }
	| { kind: "deny"; reason: string; rule_name?: string };

type ApprovalDefaultAction = "allow" | "ask" | "deny";

export type BashCommandPrefix = readonly [program: string, ...args: string[]];

export type BashMatcher =
	| { command: BashCommandPrefix; exact: true; arg_globs?: never }
	| { command: BashCommandPrefix; exact?: false; arg_globs?: string[] }
	| { pipeline: BashCommandPrefix[] };

export type BashPolicyCommandMatcher = BashMatcher & { classifier: string };

interface FactAction {
	action: Exclude<ApprovalDefaultAction, "allow">;
	reason?: string;
}

export type FileFact = FactAction & ({ path_globs: string[] } | { match_all: true });
export type NetworkFact = FactAction & ({ network_scope: WebFetchTarget["scope"] } | { match_all: true });

export interface BashPolicyFact extends Partial<FactAction> {
	path_globs?: string[];
	match_all?: true;
	commands: BashPolicyCommandMatcher[];
}

export interface BashPolicyCombination {
	all: string[];
	action: Exclude<ApprovalDefaultAction, "allow">;
}

export interface ToolPolicy<F> {
	default_action: ApprovalDefaultAction;
	facts: Record<string, F>;
}

export interface BashPolicyConfig extends ToolPolicy<BashPolicyFact> {
	combinations: Record<string, BashPolicyCombination>;
}

export interface ApprovalGateConfig {
	enabled: boolean;
	ui: {
		timeout_ms: number;
		non_interactive: "block" | "allow";
	};
	tools: {
		bash: BashPolicyConfig;
		write: ToolPolicy<FileFact>;
		edit: ToolPolicy<FileFact>;
		webfetch: ToolPolicy<NetworkFact>;
	};
}

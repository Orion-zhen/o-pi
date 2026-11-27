import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { answerForChoice, DENY_WITH_INSTRUCTION, type ApprovalAnswer, type ApprovalDialogOptions } from "./runtime/interaction.ts";
import type { ShellFactEvaluation } from "./rules/shell-facts.ts";
import { stripTerminalSequences } from "../terminal-text.ts";
import type { ApprovalDecision, ApprovalRequest, ApprovalUnit, ShellApprovalRequest } from "./types.ts";

type AskDecision = Extract<ApprovalDecision, { kind: "ask" }>;
export type ApprovalLineStyle = "text" | "dim" | "added" | "removed" | "warning";
export interface ApprovalDisplayLine {
	text: string;
	style: ApprovalLineStyle;
}

/** 各前端共用审批内容，所有外部文本在此移除终端控制序列。 */
export function buildApprovalContent(request: ApprovalRequest, decision: AskDecision, showEnvironment = false): ApprovalDisplayLine[] {
	const common = [
		line(`Working directory: ${request.cwd}`, "dim"),
		...[...new Set(decision.items.map((item) => item.reason))].map((reason) => line(`Reason: ${reason}`, "warning")),
		line(""),
	];
	if ("units" in request) {
		return [
			...common,
			...approvalEnvironment(request.detail.environment, showEnvironment).map((entry) => {
				const value = entry.kind === "value" ? JSON.stringify(entry.value) : entry.kind === "unset" ? "<unset>" : '"<hidden>"';
				return line(`${entry.name}=${value}`, "dim");
			}),
			line(`Command (${lineCount(request.detail.command)} lines):`, "dim"),
			...payloadLines(request.detail.command, "text"),
			line(""),
			line("Sensitive units:", "dim"),
			...decision.items.flatMap((item, index) => [
				line(`${index + 1}. ${approvalTarget(request, item.unit, showEnvironment)}`, "warning"),
				line(`   ${item.unit.action} | ${approvalItemReason(item)}`, "dim"),
			]),
		];
	}
	if (request.tool === "write") {
		return [
			line(`Target: ${request.detail.path}`),
			...common,
			line(`Proposed content (${lineCount(request.detail.content)} lines, ${request.detail.content.length} chars):`, "dim"),
			...payloadLines(request.detail.content, "added", "+ "),
		];
	}
	if (request.tool === "webfetch") {
		return [
			line(`Target: ${request.detail.origin}`),
			...common,
			line(`URL: ${request.detail.url}`),
			line(`Resolved addresses (${request.detail.scope}):`, "dim"),
			...request.detail.addresses.map((address) => line(address, "warning")),
		];
	}
	return [
		line(`Target: ${request.detail.path}`),
		...common,
		...request.detail.edits.flatMap((edit, index) => [
			line(`Replacement ${index + 1}${edit.replace_all ? " (all matches)" : ""}:`, "dim"),
			...payloadLines(edit.old, "removed", "- "),
			...payloadLines(edit.new, "added", "+ "),
			line(""),
		]),
	];
}

export function approvalItemReason({ unit, reason }: AskDecision["items"][number]): string {
	return approvalText(unit.analysisNote ? `${reason} ${unit.analysisNote}` : reason);
}

const sensitiveName = /TOKEN|SECRET|PASS(?:WORD|WD)?|CREDENTIAL|AUTH|(?:API|PRIVATE|ACCESS)_?KEY/iu;

function hasSensitiveEnvironment(request: ShellApprovalRequest): boolean {
	return Object.entries(request.detail.environment ?? {}).some(([name, value]) => sensitiveName.test(name) && Boolean(value));
}

export function approvalTarget(request: ShellApprovalRequest, unit: ApprovalUnit, reveal = false): string {
	if (reveal || !hasSensitiveEnvironment(request)) return approvalText(unit.target.value);
	// 只显示来自原始输入的片段。嵌套脚本本身也可能是启动变量展开的结果。
	return approvalText(unit.source ?? request.detail.command);
}

export type ApprovalVariable = { name: string } & ({ kind: "value"; value: string } | { kind: "hidden" | "unset" });

export function approvalEnvironment(environment: ShellApprovalRequest["detail"]["environment"], reveal: boolean): ApprovalVariable[] {
	const entries = Object.entries(environment ?? {});
	const secrets = entries.flatMap(([name, value]) => sensitiveName.test(name) && value ? [value] : []);
	return entries.map(([name, value]) => {
		if (value === null) return { name, kind: "unset" };
		if (!reveal && secrets.some((secret) => value.includes(secret))) return { name, kind: "hidden" };
		return { name, kind: "value", value: approvalText(value) };
	});
}

export async function finishApprovalChoice(choice: string | undefined, ui: Pick<ExtensionUIContext, "input">, opts?: ApprovalDialogOptions): Promise<ApprovalAnswer> {
	if (choice !== DENY_WITH_INSTRUCTION) return answerForChoice(choice);
	const instruction = await ui.input("Instruction for agent", "Explain why this tool call was denied or what the agent should do instead.", opts);
	return { kind: "denied", instruction };
}

export function formatApprovalPrompt(request: ApprovalRequest, decision: AskDecision): string {
	return [`Approval required | ${request.tool}`, ...buildApprovalContent(request, decision).map(({ text }) => text)].join("\n");
}

function payloadLines(payload: string, style: ApprovalLineStyle, prefix = ""): ApprovalDisplayLine[] {
	return approvalText(payload).split("\n").map((text) => ({ text: `${prefix}${text}`, style }));
}

function line(text: string, style: ApprovalLineStyle = "text"): ApprovalDisplayLine {
	return { text: approvalText(text), style };
}

export function approvalText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n?/gu, "\n")
		.replace(/\t/gu, "    ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "?");
}

function lineCount(value: string): number {
	return value.length === 0 ? 0 : value.split(/\r\n?|\n/u).length;
}

export function formatShellPolicyEvaluation(request: ShellApprovalRequest, evaluation: ShellFactEvaluation, decision: ApprovalDecision): string {
	return [
		`Decision: ${decision.kind}`,
		"",
		"Facts:",
		...(evaluation.facts.length === 0 ? ["- none"] : evaluation.facts.map((fact) => `- ${fact}`)),
		"",
		"Matches:",
		...(evaluation.matches.length === 0
			? ["- none"]
			: evaluation.matches.map((match) => `- ${match.fact} <- ${match.classifier}: ${approvalTarget(request, match.unit)}`)),
		...(evaluation.unresolved.length ? ["", "Possible matches:", ...evaluation.unresolved.map(({ rule, unit }) => `- ${rule}: ${approvalTarget(request, unit)}`)] : []),
		...(evaluation.combinations.length === 0
			? []
			: ["", "Combinations:", ...evaluation.combinations.map(({ name }) => `- ${name}`)]),
	].join("\n");
}

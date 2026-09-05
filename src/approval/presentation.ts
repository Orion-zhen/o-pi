import { stripTerminalSequences } from "../terminal-text.js";
import type { ApprovalDecision, ApprovalRequest } from "./types.js";

type AskDecision = Extract<ApprovalDecision, { kind: "ask" }>;
export type ApprovalLineStyle = "text" | "dim" | "added" | "removed" | "warning";
export interface ApprovalDisplayLine {
	text: string;
	style: ApprovalLineStyle;
}

/** TUI 和 RPC 共用审批内容，所有外部文本在此移除终端控制序列。 */
export function buildApprovalContent(request: ApprovalRequest, decision: AskDecision): ApprovalDisplayLine[] {
	const common = [
		line(`Working directory: ${request.cwd}`, "dim"),
		...[...new Set(decision.items.map((item) => item.reason))].map((reason) => line(`Reason: ${reason}`, "warning")),
		line(""),
	];
	if (request.tool === "bash") {
		return [
			...common,
			line(`Command (${lineCount(request.detail.command)} lines):`, "dim"),
			...payloadLines(request.detail.command, "text"),
			line(""),
			line("Sensitive units:", "dim"),
			...decision.items.flatMap((item, index) => [
				line(`${index + 1}. ${item.unit.target.value}`, "warning"),
				line(`   ${item.unit.action} | ${item.reason}`, "dim"),
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
			line("Resolved addresses:", "dim"),
			...request.detail.addresses.map((item) => line(item.address, "warning")),
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

export function formatApprovalPrompt(request: ApprovalRequest, decision: AskDecision): string {
	return [`Approval required | ${request.tool}`, ...buildApprovalContent(request, decision).map(({ text }) => text)].join("\n");
}

function payloadLines(payload: string, style: ApprovalLineStyle, prefix = ""): ApprovalDisplayLine[] {
	return safeText(payload).split("\n").map((text) => ({ text: `${prefix}${text}`, style }));
}

function line(text: string, style: ApprovalLineStyle = "text"): ApprovalDisplayLine {
	return { text: safeText(text), style };
}

function safeText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n?/gu, "\n")
		.replace(/\t/gu, "    ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "?");
}

function lineCount(value: string): number {
	return value.length === 0 ? 0 : value.split(/\r\n?|\n/u).length;
}

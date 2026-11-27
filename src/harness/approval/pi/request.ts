import path from "node:path";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { ShellParams } from "../../shell-runtime/prepare.ts";
import type { WriteParams } from "../../file-tools/write/types.ts";
import type { EditParams } from "../../file-tools/edit/types.ts";
import { resolveNativeInputPath } from "../../filesystem/kernel/access-policy.ts";
import { isSystemTemporaryDescendant, rulePath } from "../request/path.ts";
import type { ApprovalUnit, SingleTargetRequest, WebFetchTarget } from "../types.ts";

export type ApprovalToolCall = Pick<ToolCallEvent, "type" | "toolCallId"> & (
	| { toolName: "bash"; input: ShellParams }
	| { toolName: "powershell"; input: ShellParams }
	| { toolName: "webfetch"; input: { url: string } }
	| { toolName: "write"; input: WriteParams }
	| { toolName: "edit"; input: EditParams }
);

/** Pi 在 tool_call 前已按注册工具的 schema 校验参数。 */
export function isApprovalToolCall(event: ToolCallEvent): event is ToolCallEvent & ApprovalToolCall {
	return event.toolName === "bash" || event.toolName === "powershell" || event.toolName === "write" || event.toolName === "edit" || event.toolName === "webfetch";
}

export function buildFileApprovalRequest(event: Extract<ApprovalToolCall, { toolName: "write" | "edit" }>, cwd: string): SingleTargetRequest {
	const input = event.input.path;
	cwd = rulePath(path.resolve(cwd));
	const target = input.startsWith("skill://") ? input : rulePath(resolveNativeInputPath(cwd, input));
	const unit: ApprovalUnit = {
		action: event.toolName === "write" ? "write_file" : "edit_file",
		target: { kind: "path", value: target },
		...(isSystemTemporaryDescendant(target) && { effect_scope: "temporary" }),
		remember: true,
	};
	return event.toolName === "write"
		? { tool: "write", cwd, unit, detail: { path: target, content: event.input.content } }
		: { tool: "edit", cwd, unit, detail: { path: target, edits: event.input.edits } };
}

export function buildWebFetchApprovalRequest(cwd: string, target: WebFetchTarget): SingleTargetRequest {
	return {
		tool: "webfetch", cwd: rulePath(path.resolve(cwd)), detail: target,
		unit: { action: "fetch_url", target: { kind: "url", value: target.origin }, remember: true },
	};
}

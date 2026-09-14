import path from "node:path";
import { isToolCallEventType, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { resolveNativeInputPath } from "../../filesystem/kernel/access-policy.js";
import { loadWebToolsConfig } from "../../web-tools/config.js";
import { inspectWebFetchTarget } from "../../web-tools/network/network-policy.js";
import { buildBashApprovalRequest } from "../request/bash/parse.js";
import { isSystemTemporaryDescendant } from "../request/path.js";
import type { ApprovalEditReplacement, ApprovalRequest, ApprovalUnit } from "../types.js";

type WriteApprovalInput = Record<string, unknown> & { path: string; content: string };
type EditApprovalInput = Record<string, unknown> & { path: string; edits: ApprovalEditReplacement[] };
type WebFetchApprovalInput = Record<string, unknown> & { url: string };

export function isApprovalToolCall(event: ToolCallEvent): boolean {
	return event.toolName === "bash" || event.toolName === "write" || event.toolName === "edit" || event.toolName === "webfetch";
}

/** Pi 在 tool_call 前已完成工具参数校验，这里只建立审批目标。 */
export async function buildApprovalRequest(event: ToolCallEvent, cwd: string): Promise<ApprovalRequest | undefined> {
	if (isToolCallEventType("bash", event)) {
		return event.input.command.trim().length === 0 ? undefined : buildBashApprovalRequest(event.input.command, cwd);
	}
	cwd = path.resolve(cwd).replace(/\\/g, "/");
	if (isToolCallEventType<"write", WriteApprovalInput>("write", event)) {
		if (event.input.path.length === 0) return undefined;
		const targetPath = fileToolTarget(event.input.path, cwd);
		return {
			tool: "write", cwd,
			detail: { path: targetPath, content: event.input.content },
			units: [pathUnit("write_file", targetPath)],
		};
	}
	if (isToolCallEventType<"edit", EditApprovalInput>("edit", event)) {
		if (event.input.path.length === 0) return undefined;
		const targetPath = fileToolTarget(event.input.path, cwd);
		return {
			tool: "edit", cwd,
			detail: { path: targetPath, edits: event.input.edits },
			units: [pathUnit("edit_file", targetPath)],
		};
	}
	if (isToolCallEventType<"webfetch", WebFetchApprovalInput>("webfetch", event)) {
		const webConfig = await loadWebToolsConfig();
		const inspection = await inspectWebFetchTarget(event.input.url, { allowedFakeIpRanges: webConfig.network.fake_ip_ranges });
		// 无效请求交给工具报告错误，公网请求仍由网络边界检查 DNS 和重定向。
		if ("error" in inspection || inspection.status === "public") return undefined;
		const origin = inspection.validated.url.origin;
		return {
			tool: "webfetch", cwd,
			detail: { url: inspection.validated.displayUrl, origin, addresses: inspection.addresses },
			units: [{
				action: "fetch_url", target: { kind: "url", value: origin },
				remember: { session: true, persistent: true },
			}],
		};
	}
	return undefined;
}

function fileToolTarget(input: string, cwd: string): string {
	return input.startsWith("skill://") ? input : resolveNativeInputPath(cwd, input).replace(/\\/g, "/");
}

function pathUnit(action: "write_file" | "edit_file", targetPath: string): ApprovalUnit {
	return {
		action,
		target: { kind: "path", value: targetPath },
		...(isSystemTemporaryDescendant(targetPath) ? { effect_scope: "temporary" as const } : {}),
		remember: { session: true, persistent: true },
	};
}

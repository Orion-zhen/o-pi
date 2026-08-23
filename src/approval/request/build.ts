import path from "node:path";
import { isToolCallEventType, type ToolCallEvent } from "@earendil-works/pi-coding-agent";

import type { ApprovalEditReplacement, ApprovalRequest, ApprovalRequestDetail, ApprovalUnit } from "../types.js";
import { parseBashApprovalUnits } from "./bash/parse.js";
import { isSystemTemporaryDescendant, normalizeTargetPath } from "./path.js";

type WriteApprovalInput = Record<string, unknown> & { path: string; content: string };
type EditApprovalInput = Record<string, unknown> & { path: string; edits: ApprovalEditReplacement[] };

export async function buildApprovalRequest(event: ToolCallEvent, cwd: string): Promise<ApprovalRequest | undefined> {
	if (isToolCallEventType("bash", event)) {
		const command = event.input.command;
		if (command.trim().length === 0) return undefined;
		const parsed = await parseBashApprovalUnits(command, cwd);
		return request({
			tool: "bash",
			cwd,
			summary: "Run shell input",
			detail: { kind: "bash", command },
			units: parsed.units,
		});
	}

	if (isToolCallEventType<"write", WriteApprovalInput>("write", event)) {
		const { path: filePath, content } = event.input;
		if (filePath.length === 0) return undefined;
		const targetPath = normalizeTargetPath(filePath, cwd);
		return pathRequest(
			"write",
			"write_file",
			`Write file: ${targetPath}`,
			{ kind: "write", path: targetPath, content },
			targetPath,
			cwd,
		);
	}

	if (isToolCallEventType<"edit", EditApprovalInput>("edit", event)) {
		const { path: filePath, edits } = event.input;
		if (filePath.length === 0) return undefined;
		const targetPath = normalizeTargetPath(filePath, cwd);
		return pathRequest(
			"edit",
			"edit_file",
			`Edit file: ${targetPath}`,
			{ kind: "edit", path: targetPath, edits },
			targetPath,
			cwd,
		);
	}

	return undefined;
}

function pathRequest(
	tool: "write" | "edit",
	action: "write_file" | "edit_file",
	summary: string,
	detail: ApprovalRequestDetail,
	targetPath: string,
	cwd: string,
): ApprovalRequest {
	const unit: ApprovalUnit = {
		action,
		target: { kind: "path", value: targetPath },
		...(isSystemTemporaryDescendant(targetPath) ? { effect_scope: "temporary" as const } : {}),
		remember: { session: true, persistent: true },
	};
	return request({ tool, cwd, summary, detail, units: [unit] });
}

function request(input: {
	tool: ApprovalRequest["tool"];
	cwd: string;
	summary: string;
	detail: ApprovalRequestDetail;
	units: ApprovalUnit[];
}): ApprovalRequest {
	return {
		tool: input.tool,
		cwd: normalizeCwd(input.cwd),
		summary: input.summary,
		detail: input.detail,
		units: input.units,
	};
}

function normalizeCwd(cwd: string): string {
	return path.resolve(cwd).replace(/\\/g, "/");
}

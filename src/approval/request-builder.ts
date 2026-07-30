import path from "node:path";
import { isToolCallEventType, type ToolCallEvent } from "@earendil-works/pi-coding-agent";

import { parseBashApprovalUnits } from "./bash-parser.js";
import { normalizeTargetPath } from "./path.js";
import type { ApprovalRequest, ApprovalUnit } from "./types.js";

export async function buildApprovalRequest(event: ToolCallEvent, cwd: string): Promise<ApprovalRequest | undefined> {
	if (isToolCallEventType("bash", event)) {
		const command = event.input.command;
		if (typeof command !== "string" || command.trim().length === 0) return undefined;
		const parsed = await parseBashApprovalUnits(command, cwd);
		return request({
			tool: "bash",
			cwd,
			summary: `Run shell input: ${command}`,
			units: parsed.units,
		});
	}

	if (isToolCallEventType("write", event)) {
		const filePath = event.input.path;
		if (typeof filePath !== "string" || filePath.length === 0) return undefined;
		const targetPath = normalizeTargetPath(filePath, cwd);
		return pathRequest("write", "write_file", `Write file: ${targetPath}`, targetPath, cwd);
	}

	if (isToolCallEventType("edit", event)) {
		const filePath = event.input.path;
		if (typeof filePath !== "string" || filePath.length === 0) return undefined;
		const targetPath = normalizeTargetPath(filePath, cwd);
		return pathRequest("edit", "edit_file", `Edit file: ${targetPath}`, targetPath, cwd);
	}

	return undefined;
}

function pathRequest(
	tool: "write" | "edit",
	action: "write_file" | "edit_file",
	summary: string,
	targetPath: string,
	cwd: string,
): ApprovalRequest {
	const unit: ApprovalUnit = {
		action,
		target: { kind: "path", value: targetPath },
		remember: { session: true, persistent: true },
	};
	return request({ tool, cwd, summary, units: [unit] });
}

function request(input: {
	tool: string;
	cwd: string;
	summary: string;
	units: ApprovalUnit[];
}): ApprovalRequest {
	return {
		tool: input.tool,
		cwd: normalizeCwd(input.cwd),
		summary: input.summary,
		units: input.units,
	};
}

function normalizeCwd(cwd: string): string {
	return path.resolve(cwd).replace(/\\/g, "/");
}

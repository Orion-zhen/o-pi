import path from "node:path";
import { isToolCallEventType, type ToolCallEvent } from "@earendil-works/pi-coding-agent";

import type {
	ApprovalEditReplacement,
	ApprovalRequest,
	ApprovalUnit,
	BashApprovalRequest,
} from "../types.js";
import { parseBashApprovalUnits } from "./bash/parse.js";
import { isSystemTemporaryDescendant, normalizeTargetPath } from "./path.js";

type WriteApprovalInput = Record<string, unknown> & { path: string; content: string };
type EditApprovalInput = Record<string, unknown> & { path: string; edits: ApprovalEditReplacement[] };

export async function buildApprovalRequest(event: ToolCallEvent, cwd: string): Promise<ApprovalRequest | undefined> {
	if (isToolCallEventType("bash", event)) {
		if (event.input.command.trim().length === 0) return undefined;
		return buildBashApprovalRequest(event.input.command, cwd);
	}

	if (isToolCallEventType<"write", WriteApprovalInput>("write", event)) {
		const { path: filePath, content } = event.input;
		if (filePath.length === 0) return undefined;
		const targetPath = normalizeTargetPath(filePath, cwd);
		return {
			tool: "write",
			cwd: normalizeCwd(cwd),
			summary: `Write file: ${targetPath}`,
			detail: { kind: "write", path: targetPath, content },
			units: [pathUnit("write_file", targetPath)],
		};
	}

	if (isToolCallEventType<"edit", EditApprovalInput>("edit", event)) {
		const { path: filePath, edits } = event.input;
		if (filePath.length === 0) return undefined;
		const targetPath = normalizeTargetPath(filePath, cwd);
		return {
			tool: "edit",
			cwd: normalizeCwd(cwd),
			summary: `Edit file: ${targetPath}`,
			detail: { kind: "edit", path: targetPath, edits },
			units: [pathUnit("edit_file", targetPath)],
		};
	}

	return undefined;
}

export async function buildBashApprovalRequest(command: string, cwd: string): Promise<BashApprovalRequest> {
	const parsed = await parseBashApprovalUnits(command, cwd);
	return {
		tool: "bash",
		cwd: normalizeCwd(cwd),
		summary: "Run shell input",
		detail: { kind: "bash", command },
		units: parsed.units,
	};
}

function pathUnit(action: "write_file" | "edit_file", targetPath: string): ApprovalUnit {
	return {
		action,
		target: { kind: "path", value: targetPath },
		...(isSystemTemporaryDescendant(targetPath) ? { effect_scope: "temporary" as const } : {}),
		remember: { session: true, persistent: true },
	};
}


function normalizeCwd(cwd: string): string {
	return path.resolve(cwd).replace(/\\/g, "/");
}

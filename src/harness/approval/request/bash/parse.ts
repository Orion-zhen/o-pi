import type { ApprovalUnit, BashApprovalRequest } from "../../types.js";
import { normalizeTargetPath } from "../path.js";
import { analyzeBashScript } from "./analysis.js";
import { normalizeSource } from "./syntax.js";

export async function buildBashApprovalRequest(command: string, cwd: string): Promise<BashApprovalRequest> {
	return {
		tool: "bash", cwd: normalizeTargetPath(".", cwd),
		detail: { command }, units: await parseBashApprovalUnits(command, cwd),
	};
}

/** 将 Bash AST 拆成可独立匹配的简单命令和文件写重定向。 */
async function parseBashApprovalUnits(command: string, cwd: string): Promise<ApprovalUnit[]> {
	const units: ApprovalUnit[] = [];
	const parsed = await analyzeBashScript(command, cwd, 0, units);
	if (!parsed) return [opaqueCommandUnit(command)];
	if (units.length === 0) units.push(plainCommandUnit(command));
	return units;
}

function opaqueCommandUnit(command: string): ApprovalUnit {
	return {
		action: "execute",
		target: { kind: "command", value: normalizeSource(command), effective_value: `<opaque> ${command}` },
		remember: { session: true, persistent: false },
	};
}

function plainCommandUnit(command: string): ApprovalUnit {
	return {
		action: "execute",
		target: { kind: "command", value: normalizeSource(command), effective_value: command },
		remember: { session: true, persistent: true },
	};
}

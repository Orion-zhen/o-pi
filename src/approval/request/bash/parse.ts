import type { ApprovalUnit } from "../../types.js";
import { analyzeBashScript } from "./analysis.js";
import { normalizeSource } from "./syntax.js";

/** 将 Bash AST 拆成可独立匹配的简单命令和文件写重定向。 */
interface ParsedBashUnits {
	units: ApprovalUnit[];
}

export async function parseBashApprovalUnits(command: string, cwd: string): Promise<ParsedBashUnits> {
	try {
		const units: ApprovalUnit[] = [];
		const parsed = await analyzeBashScript(command, cwd, 0, units);
		if (!parsed) return { units: [opaqueCommandUnit(command)] };
		if (units.length === 0) units.push(plainCommandUnit(command));
		return { units };
	} catch {
		return { units: [opaqueCommandUnit(command)] };
	}
}

function opaqueCommandUnit(command: string): ApprovalUnit {
	return {
		action: "execute",
		target: { kind: "command", value: normalizeSource(command), match_value: `<opaque> ${command}` },
		remember: { session: true, persistent: false },
	};
}

function plainCommandUnit(command: string): ApprovalUnit {
	return {
		action: "execute",
		target: { kind: "command", value: normalizeSource(command), match_value: command },
		remember: { session: true, persistent: true },
	};
}

import { formatErrorModelResult } from "../model-output.js";
import { isFailedDetails } from "../guards.js";
import { withNativeLsDetails } from "../native.js";
import { formatCompactLsResult, listWorkspaceDirectory } from "../../tools/ls.js";
import type { LsParams } from "../../types.js";

export async function executeLs(params: LsParams, cwd: string) {
	const result = await listWorkspaceDirectory(cwd, params);
	if (isFailedDetails(result)) {
		return { content: [{ type: "text" as const, text: formatErrorModelResult("ls", result) }], details: result };
	}
	return { content: [{ type: "text" as const, text: formatCompactLsResult(result) }], details: withNativeLsDetails(result) };
}

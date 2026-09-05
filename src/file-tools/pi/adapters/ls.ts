import { listDirectory } from "../../ls/command.js";
import { formatCompactLsResult } from "../../ls/presenter.js";
import type { LsParams, LsSuccess } from "../../ls/types.js";
import { isFailed } from "../../shared/result.js";
import { withFileToolsInvocation, type FileToolRuntime } from "../invocation.js";

export async function executeLs(params: LsParams, runtime: FileToolRuntime) {
	return withFileToolsInvocation(runtime, async (opened) => {
		const result = await listDirectory(params, {
			filesystem: opened.filesystem,
			operation: opened.context,
			entryLimit: opened.limits.ls_entries,
		});
		if (isFailed(result)) return result;
		return {
			content: [{ type: "text", text: formatCompactLsResult(result) }],
			details: withNativeLsDetails(result),
		};
	});
}

type NativeLsDetails = LsSuccess & {
	/** Pi 原生目录呈现器识别这个条目截断标记。 */
	entryLimitReached?: number;
};

function withNativeLsDetails(result: LsSuccess): NativeLsDetails {
	return result.truncated ? { ...result, entryLimitReached: result.returned_entries } : result;
}

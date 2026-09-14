import { listDirectory } from "../../ls/command.ts";
import { formatCompactLsResult } from "../../ls/presenter.ts";
import type { LsParams, LsSuccess } from "../../ls/types.ts";
import { isFailed } from "../../shared/result.ts";
import { withFileToolsInvocation, type FileToolRuntime } from "../invocation.ts";

export async function executeLs(params: LsParams, runtime: FileToolRuntime) {
	return withFileToolsInvocation(runtime, async (opened) => {
		const result = await listDirectory(params, opened);
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

import { listDirectory } from "../../ls/command.js";
import { formatCompactLsResult } from "../../ls/presenter.js";
import type { LsParams, LsSuccess } from "../../ls/types.js";
import type { FileToolsHost } from "../../runtime/host.js";
import { isFailed } from "../../shared/result.js";
import { formatErrorModelResult } from "../model-output.js";

export interface ExecuteLsOptions {
	readonly cwd: string;
	readonly sessionId: string;
	readonly signal?: AbortSignal;
	readonly host: FileToolsHost;
}

export async function executeLs(params: LsParams, options: ExecuteLsOptions) {
	const opened = await options.host.open({
		cwd: options.cwd,
		sessionId: options.sessionId,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	if (isFailed(opened)) return failedResult(opened);
	try {
		const result = await listDirectory(params, {
			filesystem: opened.filesystem,
			operation: opened.context,
			entryLimit: opened.limits.ls_entries,
		});
		if (isFailed(result)) return failedResult(result);
		return {
			content: [{ type: "text" as const, text: formatCompactLsResult(result) }],
			details: withNativeLsDetails(result),
		};
	} finally {
		opened.dispose();
	}
}

function failedResult(result: Parameters<typeof formatErrorModelResult>[0]) {
	return { content: [{ type: "text" as const, text: formatErrorModelResult(result) }], details: result };
}

type NativeLsDetails = LsSuccess & {
	/** Pi's native ls renderer recognizes this entry-limit marker. */
	entryLimitReached?: number;
};

function withNativeLsDetails(result: LsSuccess): NativeLsDetails {
	if (!result.truncated) return result;
	return {
		...result,
		entryLimitReached: result.returned_entries,
	};
}

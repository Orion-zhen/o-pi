import type { FilesystemPathAccess } from "../../../filesystem/contracts/access.js";
import { FindTool } from "../../find/command.js";
import type { FindParams } from "../../find/types.js";
import type { FileToolsHost } from "../../runtime/host.js";
import { isFailed } from "../../shared/result.js";
import { formatErrorModelResult } from "../model-output.js";

export interface ExecuteFindOptions {
	readonly cwd: string;
	readonly sessionId: string;
	readonly signal?: AbortSignal;
	readonly host: FileToolsHost;
	readonly pathAccess: FilesystemPathAccess;
}

export function createFindAdapter() {
	const tool = new FindTool();
	return {
		async execute(params: FindParams, options: ExecuteFindOptions) {
			const opened = await options.host.open({
				cwd: options.cwd,
				sessionId: options.sessionId,
				...(options.signal === undefined ? {} : { signal: options.signal }),
				pathAccess: options.pathAccess,
			});
			if (isFailed(opened)) return failedResult(opened);
			try {
				const result = await tool.execute(params, {
					filesystem: opened.filesystem,
					operation: opened.context,
					limits: opened.limits,
				});
				if (isFailed(result)) return failedResult(result);
				return { content: [{ type: "text" as const, text: result.content }], details: result.details };
			} finally {
				opened.dispose();
			}
		},
		dispose() {
			tool.dispose();
		},
	};
}

function failedResult(result: Parameters<typeof formatErrorModelResult>[0]) {
	return { content: [{ type: "text" as const, text: formatErrorModelResult(result) }], details: result };
}

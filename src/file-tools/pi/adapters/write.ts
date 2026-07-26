import { writeFile } from "../../write/command.js";
import type { WriteParams } from "../../write/types.js";
import type { FileToolsHost } from "../../runtime/host.js";
import { isFailed } from "../../shared/result.js";
import { formatWriteModelResult } from "../../write/presenter.js";
import { formatErrorModelResult } from "../model-output.js";
import type { LazyRepoMap } from "../lazy-repo-map.js";
import { createWritePorts } from "../ports/write.js";
import { piTextDiffGenerator } from "../ports/text-diff.js";
import type { FileToolLspHooks } from "../../types.js";

export async function executeWrite(
	params: WriteParams,
	runtime: {
		cwd: string;
		sessionId: string;
		signal?: AbortSignal;
		host: FileToolsHost;
		lsp: FileToolLspHooks;
		repoMap: LazyRepoMap;
	},
) {
	const opened = await runtime.host.open({
		cwd: runtime.cwd,
		sessionId: runtime.sessionId,
		...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
	});
	if (isFailed(opened)) return failedResult(opened);
	try {
		const ports = createWritePorts(opened, runtime.lsp, runtime.repoMap);
		const result = await writeFile(params, {
			filesystem: opened.filesystem,
			operation: opened.context,
			diff: piTextDiffGenerator,
			diagnostics: ports.diagnostics,
			mutationObserver: ports.observer,
		});
		if (isFailed(result)) return failedResult(result);
		return {
			content: [{ type: "text" as const, text: formatWriteModelResult(result, ports.impact()) }],
			details: result,
		};
	} finally {
		opened.dispose();
	}
}

function failedResult(result: Parameters<typeof formatErrorModelResult>[0]) {
	return { content: [{ type: "text" as const, text: formatErrorModelResult(result) }], details: result };
}

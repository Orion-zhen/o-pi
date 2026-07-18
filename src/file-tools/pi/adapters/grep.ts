import { formatErrorModelResult } from "../model-output.js";
import { isFailedDetails } from "../guards.js";
import type { LazyRepoMap } from "../lazy-repo-map.js";
import { formatCompactGrepResult, grepWorkspaceFiles } from "../../tools/grep.js";
import type { FileToolLspHooks, GrepParams } from "../../types.js";

export async function executeGrep(
	params: GrepParams,
	runtime: { cwd: string; signal?: AbortSignal; lsp: FileToolLspHooks; repoMap: LazyRepoMap },
) {
	const result = await grepWorkspaceFiles(runtime.cwd, params, runtime.signal, { lsp: runtime.lsp, repoMap: runtime.repoMap.query });
	if (isFailedDetails(result)) {
		return { content: [{ type: "text" as const, text: formatErrorModelResult("grep", result) }], details: result };
	}
	return { content: [{ type: "text" as const, text: formatCompactGrepResult(result) }], details: result };
}

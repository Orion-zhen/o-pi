import { formatErrorModelResult, formatWriteModelResult } from "../model-output.js";
import { isFailedDetails } from "../guards.js";
import type { LazyRepoMap } from "../lazy-repo-map.js";
import { writeWorkspaceFile } from "../../tools/write.js";
import type { FileToolLspHooks, WriteParams } from "../../types.js";

export async function executeWrite(
	params: WriteParams,
	runtime: { cwd: string; signal?: AbortSignal; lsp: FileToolLspHooks; repoMap: LazyRepoMap },
) {
	const result = await writeWorkspaceFile(runtime.cwd, params, runtime.signal, { lsp: runtime.lsp });
	if (isFailedDetails(result)) {
		return { content: [{ type: "text" as const, text: formatErrorModelResult("write", result) }], details: result };
	}
	await runtime.repoMap.syncMutation(result, runtime.cwd, runtime.signal);
	const impact = await runtime.repoMap.formatImpact(result.repo_map?.impact);
	return { content: [{ type: "text" as const, text: formatWriteModelResult(result, impact) }], details: result };
}

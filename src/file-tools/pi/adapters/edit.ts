import type { ReadVersionCache } from "../../core/read-cache.js";
import { formatEditModelResult, formatErrorModelResult, scrubVersions } from "../model-output.js";
import { isEditSuccessDetails, isFailedDetails } from "../guards.js";
import type { LazyRepoMap } from "../lazy-repo-map.js";
import { editWorkspace } from "../../tools/edit.js";
import type { EditParams, FileToolLspHooks } from "../../types.js";

export async function executeEdit(
	params: EditParams,
	runtime: {
		cwd: string;
		signal?: AbortSignal;
		versionCache: ReadVersionCache;
		lsp: FileToolLspHooks;
		repoMap: LazyRepoMap;
	},
) {
	const result = await editWorkspace(runtime.cwd, params, { versionCache: runtime.versionCache, lsp: runtime.lsp });
	if (isEditSuccessDetails(result)) await runtime.repoMap.syncMutation(result, runtime.cwd, runtime.signal);
	const impact = isEditSuccessDetails(result) ? await runtime.repoMap.formatImpact(result.repo_map?.impact) : undefined;
	const text = isEditSuccessDetails(result)
		? formatEditModelResult(result, impact)
		: isFailedDetails(result)
			? formatErrorModelResult("edit", result)
			: JSON.stringify(scrubVersions(result));
	return { content: [{ type: "text" as const, text }], details: result };
}

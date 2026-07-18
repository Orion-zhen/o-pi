import type { ReadVersionCache } from "../../core/read-cache.js";
import { formatErrorModelResult, formatReadImageModelContent, formatReadModelResult, scrubVersions } from "../model-output.js";
import { isFailedDetails, isReadImageSuccess, isReadSuccess } from "../guards.js";
import type { LazyRepoMap } from "../lazy-repo-map.js";
import { readWorkspaceFile } from "../../tools/read.js";
import type { FileToolLspHooks, ReadParams } from "../../types.js";

export async function executeRead(
	params: ReadParams,
	runtime: {
		cwd: string;
		model: { input?: readonly string[] } | undefined;
		versionCache: ReadVersionCache;
		lsp: FileToolLspHooks;
		repoMap: LazyRepoMap;
	},
) {
	const result = await readWorkspaceFile(runtime.cwd, params, {
		versionCache: runtime.versionCache,
		lsp: runtime.lsp,
		repoMap: runtime.repoMap.query,
		formatRepoMapContext: (context) => runtime.repoMap.formatReadContext(context),
	});
	if (isReadImageSuccess(result)) {
		return { content: formatReadImageModelContent(result, runtime.model), details: result };
	}
	const repoMap = isReadSuccess(result) && result.repo_map !== undefined
		? await runtime.repoMap.formatReadContext(result.repo_map)
		: undefined;
	const text = isReadSuccess(result)
		? formatReadModelResult(result, repoMap)
		: isFailedDetails(result)
			? formatErrorModelResult("read", result)
			: JSON.stringify(scrubVersions(result));
	return { content: [{ type: "text" as const, text }], details: result };
}

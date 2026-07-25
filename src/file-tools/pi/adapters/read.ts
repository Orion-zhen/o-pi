import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ReadVersionCache } from "../../core/read-cache.js";
import { formatErrorModelResult, formatReadImageModelContent, formatReadModelResult, scrubVersions } from "../model-output.js";
import { isFailedDetails, isReadImageSuccess, isReadSuccess } from "../guards.js";
import type { LazyRepoMap } from "../lazy-repo-map.js";
import { readWorkspaceFile } from "../../tools/read.js";
import type { FileToolLspHooks, ReadParams } from "../../types.js";
import { resolveReadLocator, type SkillReadIndex } from "../../../skill-context/resources.js";

export { disposeFileToolsCaches } from "../workspace-cache.js";

export async function executeRead(
	params: ReadParams,
	runtime: {
		cwd: string;
		model: { input?: readonly string[] } | undefined;
		versionCache: ReadVersionCache;
		lsp: FileToolLspHooks;
		repoMap: LazyRepoMap;
		branch: SessionEntry[];
		skillIndex: SkillReadIndex;
	},
) {
	const resolution = await resolveReadLocator(params.path, runtime.branch, runtime.skillIndex);
	if ("status" in resolution) {
		return { content: [{ type: "text" as const, text: formatErrorModelResult(resolution) }], details: resolution };
	}
	const isSkillResource = resolution.kind === "skill";
	const result = await readWorkspaceFile(runtime.cwd, {
		...params,
		path: isSkillResource ? resolution.filePath : params.path,
	}, isSkillResource ? {} : {
		versionCache: runtime.versionCache,
		lsp: runtime.lsp,
		repoMap: runtime.repoMap.query,
		formatRepoMapContext: (context) => runtime.repoMap.formatReadContext(context),
	});
	if (isSkillResource) {
		if (isReadSuccess(result) || isReadImageSuccess(result)) {
			result.path = resolution.logicalPath;
			result.skill_resource = { skill: resolution.skillName, path: resolution.relativePath };
		} else if (isFailedDetails(result) && result.error.path !== undefined) {
			result.error.path = resolution.logicalPath;
		}
	}
	if (isReadImageSuccess(result)) {
		return { content: formatReadImageModelContent(result, runtime.model), details: result };
	}
	const repoMap = isReadSuccess(result) && result.repo_map !== undefined
		? await runtime.repoMap.formatReadContext(result.repo_map)
		: undefined;
	const text = isReadSuccess(result)
		? formatReadModelResult(result, repoMap)
		: isFailedDetails(result)
			? formatErrorModelResult(result)
			: JSON.stringify(scrubVersions(result));
	return { content: [{ type: "text" as const, text }], details: result };
}

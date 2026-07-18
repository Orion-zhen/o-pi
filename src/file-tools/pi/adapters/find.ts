import { formatErrorModelResult } from "../model-output.js";
import { isFailedDetails } from "../guards.js";
import type { LazyRepoMap } from "../lazy-repo-map.js";
import { findWorkspaceFiles } from "../../tools/find.js";
import type { FindParams } from "../../types.js";

export async function executeFind(params: FindParams, runtime: { cwd: string; signal?: AbortSignal; repoMap: LazyRepoMap }) {
	const result = await findWorkspaceFiles(runtime.cwd, params, runtime.signal, { repoMap: runtime.repoMap.query });
	if (isFailedDetails(result)) {
		return { content: [{ type: "text" as const, text: formatErrorModelResult("find", result) }], details: result };
	}
	return { content: [{ type: "text" as const, text: result.content }], details: result.details };
}

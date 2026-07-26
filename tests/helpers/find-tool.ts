import { FindTool } from "../../src/file-tools/find/command.js";
import type { FindParams, FindSuccess } from "../../src/file-tools/find/types.js";
import { createFindGraphSource } from "../../src/file-tools/pi/adapters/find.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { isFailed, type ToolOutcome } from "../../src/file-tools/shared/result.js";
import type { RepoMapFileToolQuery } from "../../src/repo-map/query/file-tool-query.js";

export async function findWorkspaceFiles(
	cwd: string,
	params: FindParams,
	signal?: AbortSignal,
	runtime: { repoMap?: RepoMapFileToolQuery } = {},
): Promise<ToolOutcome<FindSuccess>> {
	const host = new FileToolsHost();
	const tool = new FindTool();
	try {
		const opened = await host.open({ cwd, sessionId: "find-test", ...(signal === undefined ? {} : { signal }) });
		if (isFailed(opened)) return opened;
		try {
			return await tool.execute(params, {
				filesystem: opened.filesystem,
				operation: opened.context,
				limits: opened.limits,
				...(runtime.repoMap === undefined ? {} : {
					graph: createFindGraphSource({
						query: runtime.repoMap,
						async formatReadContext() { return undefined; },
						async formatImpact() { return undefined; },
					}, opened),
				}),
			});
		} finally {
			opened.dispose();
		}
	} finally {
		tool.dispose();
		host.dispose();
	}
}

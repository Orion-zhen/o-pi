import type { RepoMapOutputConfig } from "../../repo-map/config/output-config.js";

export { createRepoMapFileToolQuery } from "../../repo-map/query/file-tool-query.js";
export { formatRepoMapImpact, formatRepoMapReadContext } from "../../repo-map/runtime/tool-output.js";

export async function loadRepoMapOutputConfig(): Promise<RepoMapOutputConfig> {
	const { loadRepoMapConfig } = await import("../../repo-map/config/config.js");
	return (await loadRepoMapConfig()).output;
}

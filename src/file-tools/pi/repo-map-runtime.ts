import type { RepoMapOutputConfig } from "../../repo-map/output-config.js";

export { createRepoMapFileToolQuery } from "../../repo-map/file-tool-query.js";
export { formatRepoMapImpact, formatRepoMapReadContext } from "../../repo-map/tool-output.js";

export async function loadRepoMapOutputConfig(): Promise<RepoMapOutputConfig> {
	const { loadRepoMapConfig } = await import("../../repo-map/config.js");
	return (await loadRepoMapConfig()).output;
}

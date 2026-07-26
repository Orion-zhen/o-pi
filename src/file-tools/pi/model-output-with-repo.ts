import type { EditSuccess } from "../edit/types.js";
import type { WriteSuccess } from "../write/types.js";
import type { RepoMapImpactResult } from "../../repo-map/impact.js";
import type { ReadSuccess } from "../read/types.js";
import { formatReadModelResult as formatReadResult } from "../read/presenter.js";
import { formatEditModelResult as formatEditResult } from "../edit/presenter.js";
import { formatWriteModelResult as formatWriteResult } from "../write/presenter.js";
import { formatRepoMapImpact, formatRepoMapReadContext } from "../../repo-map/tool-output.js";

export { formatErrorModelResult, scrubVersions } from "./model-output.js";

/** 保留 file-tools 公共 formatter 行为；扩展运行时使用可注入的轻量 formatter。 */
export function formatReadModelResult(result: ReadSuccess): string {
	return formatReadResult(result, formatRepoMapReadContext(result.repo_map));
}

export function formatEditModelResult(result: EditSuccess): string {
	return formatEditResult(result, formatRepoMapImpact(result.repo_map?.impact as RepoMapImpactResult | undefined));
}

export function formatWriteModelResult(result: WriteSuccess): string {
	return formatWriteResult(result, formatRepoMapImpact(result.repo_map?.impact as RepoMapImpactResult | undefined));
}

import type { EditSuccess, WriteSuccess } from "../types.js";
import type { ReadSuccess } from "../read/types.js";
import { formatReadModelResult as formatReadResult } from "../read/presenter.js";
import {
	formatEditModelResult as formatEditResult,
	formatWriteModelResult as formatWriteResult,
} from "./model-output.js";
import { formatRepoMapImpact, formatRepoMapReadContext } from "../../repo-map/tool-output.js";

export { formatErrorModelResult, scrubVersions } from "./model-output.js";

/** 保留 file-tools 公共 formatter 行为；扩展运行时使用可注入的轻量 formatter。 */
export function formatReadModelResult(result: ReadSuccess): string {
	return formatReadResult(result, formatRepoMapReadContext(result.repo_map));
}

export function formatEditModelResult(result: EditSuccess): string {
	return formatEditResult(result, formatRepoMapImpact(result.repo_map?.impact));
}

export function formatWriteModelResult(result: WriteSuccess): string {
	return formatWriteResult(result, formatRepoMapImpact(result.repo_map?.impact));
}

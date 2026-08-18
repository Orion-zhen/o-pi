import type { Theme } from "@earendil-works/pi-coding-agent";
import { getTuiIconMode, statusIcon, type ToolCardStatus } from "./icons.js";
import { compactWhitespace, truncateEnd, truncateMiddle } from "./text.js";
import type { TuiIconMode } from "./types.js";

const DEFAULT_OPTIONS: Omit<ToolCardRenderOptions, "icons"> = {
	maxTargetChars: 72,
	maxSummaryChars: 96,
};
const TOOL_WIDTH = 10;

export type { ToolCardStatus };

/** 工具卡片的最小输入；renderer 应先把复杂 details 压成 target/summary。 */
export interface ToolCardInput {
	tool: string;
	status: ToolCardStatus;
	target: string;
	summary: string;
}

/** 工具卡片长度与图标配置；截断在加主题颜色前完成。 */
export interface ToolCardRenderOptions {
	icons: TuiIconMode;
	maxTargetChars: number;
	maxSummaryChars: number;
}

/** 渲染固定 2 行 collapsed card；展开视图也应把它作为 header。 */
export function formatToolCard(
	input: ToolCardInput,
	theme: Pick<Theme, "fg" | "bold">,
	options: Partial<ToolCardRenderOptions> = {},
): string {
	const resolved: ToolCardRenderOptions = { icons: getTuiIconMode(), ...DEFAULT_OPTIONS, ...options };
	const status = input.status;
	const icon = theme.fg(colorForStatus(status), statusIcon(status, resolved.icons));
	const tool = theme.fg("toolTitle", theme.bold(compactWhitespace(input.tool).padEnd(TOOL_WIDTH)));
	const target = theme.fg("accent", truncateMiddle(compactWhitespace(input.target) || "?", resolved.maxTargetChars));
	const summary = theme.fg("toolOutput", truncateEnd(compactWhitespace(input.summary) || "working", resolved.maxSummaryChars));
	return `${icon} ${tool}${target}\n  ${summary}`;
}

function colorForStatus(status: ToolCardStatus): "warning" | "success" | "error" | "muted" {
	if (status === "running") return "warning";
	if (status === "success") return "success";
	if (status === "error") return "error";
	if (status === "warning") return "warning";
	return "muted";
}

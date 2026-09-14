import type { Theme } from "@earendil-works/pi-coding-agent";
import { statusIcon, type ToolCardStatus } from "./icons.ts";
import { compactWhitespace, truncateEnd, truncateMiddle } from "./text.ts";

const MAX_TARGET_CHARS = 72;
const MAX_SUMMARY_CHARS = 96;
const TOOL_WIDTH = 10;

export type { ToolCardStatus };

/** 工具卡片的最小输入；renderer 应先把复杂 details 压成 target/summary。 */
interface ToolCardInput {
	tool: string;
	status: ToolCardStatus;
	target: string;
	summary: string;
}

/** 渲染固定 2 行 collapsed card；展开视图也应把它作为 header。 */
export function formatToolCard(
	input: ToolCardInput,
	theme: Pick<Theme, "fg" | "bold">,
): string {
	const status = input.status;
	const icon = theme.fg(colorForStatus(status), statusIcon(status));
	const tool = theme.fg("toolTitle", theme.bold(compactWhitespace(input.tool).padEnd(TOOL_WIDTH)));
	const target = theme.fg("accent", truncateMiddle(compactWhitespace(input.target) || "?", MAX_TARGET_CHARS));
	const summary = theme.fg("toolOutput", truncateEnd(compactWhitespace(input.summary) || "working", MAX_SUMMARY_CHARS));
	return `${icon} ${tool}${target}\n  ${summary}`;
}

function colorForStatus(status: ToolCardStatus): "warning" | "success" | "error" | "muted" {
	if (status === "running") return "warning";
	if (status === "success") return "success";
	if (status === "error") return "error";
	if (status === "warning") return "warning";
	return "muted";
}

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TuiFooterToolsSnapshot } from "./types.js";

/** Home 中展示的用户语义能力分组，避免暴露扩展文件名。 */
interface CapabilityGroupDefinition {
	label: string;
	toolNames: readonly string[];
}

/** 当前工具启用状态在某个能力分组下的汇总。 */
export interface CapabilityGroupSummary {
	label: string;
	activeCount: number;
	totalCount: number;
}

/** 默认能力分组只包含工具，不包含 slash command。 */
const CAPABILITY_GROUPS: readonly CapabilityGroupDefinition[] = [
	{ label: "files", toolNames: ["ls", "read", "write", "edit", "find", "grep"] },
	{ label: "web", toolNames: ["websearch", "webfetch"] },
	{ label: "bash", toolNames: ["bash"] },
	{ label: "skill", toolNames: ["skill"] },
	{ label: "subagent", toolNames: ["subagent"] },
];

/** 按采集边界提供的工具全集和启用子集汇总能力分组。 */
export function summarizeCapabilityGroups(tools: TuiFooterToolsSnapshot | undefined): CapabilityGroupSummary[] {
	if (tools === undefined) return [];
	return CAPABILITY_GROUPS.map((group) => {
		const groupToolSet = new Set(group.toolNames);
		return {
			label: group.label,
			activeCount: tools.activeNames.filter((name) => groupToolSet.has(name)).length,
			totalCount: tools.allNames.filter((name) => groupToolSet.has(name)).length,
		};
	});
}

/** 将能力分组压缩成一行；宽度不足时安全截断。 */
export function formatCapabilitySummary(
	summaries: readonly CapabilityGroupSummary[],
	width: number,
	theme: Pick<Theme, "fg">,
): string | undefined {
	const parts = summaries
		.filter((summary) => summary.totalCount > 0)
		.map((summary) => {
			const count = summary.totalCount === 1
				? ""
				: summary.activeCount === summary.totalCount
					? `:${summary.totalCount}`
					: `:${summary.activeCount}/${summary.totalCount}`;
			const text = `${summary.label}${count}`;
			const color = summary.activeCount === 0 ? "dim" : summary.activeCount === summary.totalCount ? "success" : "warning";
			return theme.fg(color, text);
		});
	if (parts.length === 0) return undefined;
	const line = parts.join(" ");
	return visibleWidth(line) <= width ? line : truncateToWidth(line, Math.max(1, width), "…");
}

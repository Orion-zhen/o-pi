import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TuiFooterToolsSnapshot } from "./types.js";

/** banner 中展示的用户语义能力分组，避免暴露扩展文件名。 */
export interface CapabilityGroupDefinition {
	id: string;
	label: string;
	toolNames: readonly string[];
	showInBanner: boolean;
}

/** 当前工具启用状态在某个能力分组下的汇总。 */
export interface CapabilityGroupSummary {
	id: string;
	label: string;
	activeCount: number;
	totalCount: number;
}

/** 默认能力分组只包含工具，不包含 slash command。 */
export const DEFAULT_CAPABILITY_GROUPS: readonly CapabilityGroupDefinition[] = [
	{ id: "files", label: "files", toolNames: ["ls", "read", "write", "edit"], showInBanner: true },
	{ id: "search", label: "search", toolNames: ["find", "grep"], showInBanner: true },
	{ id: "shell", label: "shell", toolNames: ["bash"], showInBanner: true },
	{ id: "web", label: "web", toolNames: ["websearch", "webfetch"], showInBanner: true },
	{ id: "agent", label: "agent", toolNames: ["subagent"], showInBanner: true },
];

/** 按工具名汇总能力分组；allNames 缺失时只根据 activeNames 保守展示。 */
export function summarizeCapabilityGroups(
	tools: TuiFooterToolsSnapshot | undefined,
	groups: readonly CapabilityGroupDefinition[] = DEFAULT_CAPABILITY_GROUPS,
): CapabilityGroupSummary[] {
	if (tools === undefined) return [];
	const activeNames = uniqueNonEmpty(tools.activeNames);
	const allNames = uniqueNonEmpty(tools.allNames === undefined ? tools.activeNames : [...tools.allNames, ...tools.activeNames]);
	const activeSet = new Set(activeNames);
	const groupedNames = new Set<string>();
	const summaries: CapabilityGroupSummary[] = [];

	for (const group of groups) {
		const groupToolSet = new Set(group.toolNames);
		for (const name of group.toolNames) groupedNames.add(name);
		const totalCount = allNames.filter((name) => groupToolSet.has(name)).length;
		if (!group.showInBanner || totalCount === 0) continue;
		const activeCount = activeNames.filter((name) => groupToolSet.has(name)).length;
		summaries.push({ id: group.id, label: group.label, activeCount, totalCount });
	}

	const otherNames = allNames.filter((name) => !groupedNames.has(name));
	if (otherNames.length > 0) {
		const otherSet = new Set(otherNames);
		const activeCount = activeNames.filter((name) => otherSet.has(name) || !allNames.includes(name)).length;
		summaries.push({ id: "other", label: "other", activeCount, totalCount: otherNames.length });
	}

	return summaries;
}

/** 将能力分组压缩成一行；宽度不足时安全截断。 */
export function formatCapabilitySummary(
	summaries: readonly CapabilityGroupSummary[],
	width: number,
	theme?: Pick<Theme, "fg">,
): string | undefined {
	const parts = summaries
		.filter((summary) => summary.totalCount > 0)
		.map((summary) => {
			const count = summary.activeCount >= summary.totalCount ? `${summary.totalCount}` : `${summary.activeCount}/${summary.totalCount}`;
			const text = `${summary.label}:${count}`;
			return theme === undefined ? text : theme.fg(summary.activeCount >= summary.totalCount ? "success" : "warning", text);
		});
	if (parts.length === 0) return undefined;
	const line = parts.join(" ");
	return visibleWidth(line) <= width ? line : truncateToWidth(line, Math.max(1, width), "…");
}

function uniqueNonEmpty(names: readonly string[]): string[] {
	return [...new Set(names.filter((name) => name.length > 0))];
}

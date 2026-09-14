import type { LspWorkspace } from "../manager/workspace.ts";
import { fileUriToPath, workspaceRelativePath } from "../protocol/uri.ts";
import type { LspDiagnosticSnapshot, LspRelatedDiagnostics } from "../types.ts";
import { newDiagnosticItems } from "./ledger.ts";

/** 只消费本次拉取报告明确关联的文件，不推断全工作区因果关系。 */
export function relatedDiagnostics(
	workspace: LspWorkspace,
	reports: readonly LspDiagnosticSnapshot[],
	baselines: readonly LspDiagnosticSnapshot[],
	excluded: Set<string>,
	maxItems: number,
): LspRelatedDiagnostics[] {
	const result: LspRelatedDiagnostics[] = [];
	let remaining = maxItems;
	for (const report of [...reports].sort((left, right) => left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0)) {
		if (remaining <= 0 || result.length === 3) break;
		if (excluded.has(report.uri)) continue;
		const filePath = fileUriToPath(report.uri);
		if (filePath === undefined || workspace.sourceForFile(filePath) !== report.source) continue;
		const path = workspaceRelativePath(workspace.root, filePath);
		if (path === undefined) continue;
		const before = baselines.find((baseline) => baseline.source === report.source && baseline.uri === report.uri);
		const known = before?.known === true;
		const items = (known ? newDiagnosticItems(report.items, before.items) : report.items)
			.filter((item) => item.severity === "error").slice(0, remaining);
		if (items.length === 0) continue;
		result.push({ path, baseline: known ? "known" : "unknown", items });
		excluded.add(report.uri);
		remaining -= items.length;
	}
	return result;
}

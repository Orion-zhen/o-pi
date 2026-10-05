import type { CodeNavigation } from "../../code-index/types.ts";

/** 搜索结果最多展示两个位置，优先确定调用关系并保留不同种类。 */
export function selectNavigation(values: readonly CodeNavigation[]): CodeNavigation[] {
	const order = { caller: 0, callee: 1, reference: 2 };
	const sorted = [...values].sort((a, b) => order[a.kind] - order[b.kind] || Number(a.ambiguous === true) - Number(b.ambiguous === true)
		|| a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
	const unique = new Map<string, CodeNavigation>();
	for (const value of sorted) {
		const key = `${value.path}\0${value.line}\0${value.column}`;
		if (!unique.has(key)) unique.set(key, value);
	}
	const candidates = [...unique.values()];
	const first = candidates[0];
	if (first === undefined) return [];
	const otherKind = candidates.find((value) => value.kind !== first.kind);
	const second = otherKind ?? candidates[1];
	return second === undefined ? [first] : [first, second];
}

import { mergeReadRanges, type ReadRange, type ReadRangeField, type ResolvedReadRange } from "../../content-ranges.ts";
import { fail, type ToolOutcome } from "../shared/result.ts";

/** 先验证所有起点，再裁剪末端并合并相邻、重叠区间。 */
export function resolveReadRanges(
	ranges: readonly ReadRange[] | undefined,
	total: number,
	field: ReadRangeField,
	path: string,
): ToolOutcome<ResolvedReadRange[]> {
	if (ranges === undefined) return [{ start: 1, end: total }];
	for (const range of ranges) {
		if (range.start > total) return fail("INVALID_PATH", `${field} start ${range.start} is outside 1-${total}.`, { path });
	}
	return mergeReadRanges(ranges.map((range) => ({ start: range.start, end: Math.min(range.end ?? total, total) })));
}

import type { IndexedCodeUnit } from "./types.js";

/** 最小代码单元优先，相同范围按稳定坐标与身份排序。 */
export function compareCodeUnitNesting(left: IndexedCodeUnit, right: IndexedCodeUnit): number {
	return (left.endByte - left.startByte) - (right.endByte - right.startByte)
		|| left.startByte - right.startByte
		|| (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

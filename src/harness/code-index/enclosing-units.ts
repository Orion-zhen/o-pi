import type { IndexedCodeUnit } from "./types.ts";
import { compareCodeUnitNesting } from "./units.ts";

type ByteRange = { readonly startByte: number; readonly endByte: number };

/** 按起点扫描，Fenwick 树按终点保存最小包围单元。结果保持查询顺序。 */
export function enclosingCodeUnits(
	units: readonly IndexedCodeUnit[],
	ranges: readonly ByteRange[],
): Array<IndexedCodeUnit | undefined> {
	const ordered = [...units].sort((a, b) => a.startByte - b.startByte);
	const ends = [...new Set(units.map((unit) => unit.endByte))].sort((a, b) => a - b);
	const best: Array<IndexedCodeUnit | undefined> = new Array(ends.length + 1);
	const result: Array<IndexedCodeUnit | undefined> = new Array(ranges.length);
	const queries = ranges.map((range, index) => ({ range, index })).sort((a, b) => a.range.startByte - b.range.startByte);
	let cursor = 0;
	for (const { range, index } of queries) {
		for (let unit = ordered[cursor]; unit !== undefined && unit.startByte <= range.startByte; unit = ordered[++cursor]) {
			for (let slot = ends.length - lowerBound(ends, unit.endByte); slot < best.length; slot += slot & -slot) {
				const current = best[slot];
				if (current === undefined || compareCodeUnitNesting(unit, current) < 0) best[slot] = unit;
			}
		}
		let selected: IndexedCodeUnit | undefined;
		for (let slot = ends.length - lowerBound(ends, range.endByte); slot > 0; slot -= slot & -slot) {
			const unit = best[slot];
			if (unit !== undefined && (selected === undefined || compareCodeUnitNesting(unit, selected) < 0)) selected = unit;
		}
		result[index] = selected;
	}
	return result;
}

function lowerBound(values: readonly number[], value: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((values[middle] as number) < value) low = middle + 1;
		else high = middle;
	}
	return low;
}

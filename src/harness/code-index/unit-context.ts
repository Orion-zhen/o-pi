import { containsRange, hasStructuralRange } from "./structure.ts";
import type { IndexedCodeUnit } from "./types.ts";

/** 语法确认的匿名函数不采用 LSP 生成的回调名称。 */
export function codeUnitSymbol(unit: IndexedCodeUnit): string | undefined {
	if (unit.syntax?.callable === true && unit.syntax.nameRange === undefined) return undefined;
	return unit.qualifiedName ?? unit.name;
}

export function enclosingCodeSymbol(unit: IndexedCodeUnit, units: ReadonlyMap<string, IndexedCodeUnit>): string | undefined {
	let parent = unit.parentId === undefined ? undefined : units.get(unit.parentId);
	while (parent !== undefined) {
		const name = codeUnitSymbol(parent);
		if (name !== undefined && hasStructuralRange(parent) && containsRange(parent, unit)) return name;
		parent = parent.parentId === undefined ? undefined : units.get(parent.parentId);
	}
	return undefined;
}

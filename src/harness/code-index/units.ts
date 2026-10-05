import type { IndexedCodeUnit, SourceRange } from "./types.ts";

/** 声明身份使用语义选择范围，平面符号优先采用语法名称范围。 */
export function declarationAnchor(unit: IndexedCodeUnit): SourceRange | undefined {
	return unit.symbol?.type === "document" ? unit.symbol.selection : unit.syntax?.nameRange ?? unit.symbol?.range;
}

export function matchesDeclaration(unit: IndexedCodeUnit, range: SourceRange): boolean {
	const anchor = declarationAnchor(unit);
	return anchor !== undefined && range.startByte === anchor.startByte && range.endByte >= anchor.endByte
		|| unit.syntax !== undefined && range.startByte === unit.syntax.range.startByte && range.endByte === unit.syntax.range.endByte;
}

/** 匿名单元没有声明锚点时，从单元起点查询。 */
export function queryAnchor(unit: IndexedCodeUnit): SourceRange {
	return declarationAnchor(unit) ?? unit;
}

/** 最小代码单元优先，相同范围按稳定坐标与身份排序。 */
export function compareCodeUnitNesting(left: IndexedCodeUnit, right: IndexedCodeUnit): number {
	return (left.endByte - left.startByte) - (right.endByte - right.startByte)
		|| left.startByte - right.startByte
		|| (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

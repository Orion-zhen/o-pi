import { codeUnitSymbol, enclosingCodeSymbol } from "../../code-index/unit-context.ts";
import type { IndexedCodeUnit } from "../../code-index/types.ts";
import type { CodeRegionBase } from "./candidates.ts";

/** 匿名范围与具名归属分开，展示上下文不冒充符号或声明。 */
export function codeRegionMetadata(
	unit: IndexedCodeUnit,
	units: ReadonlyMap<string, IndexedCodeUnit>,
): Pick<CodeRegionBase, "symbol" | "qualifiedSymbol" | "enclosingSymbol" | "context" | "declaration" | "declarationEndByte"> {
	const symbol = codeUnitSymbol(unit);
	const enclosing = symbol === undefined ? enclosingCodeSymbol(unit, units) : undefined;
	const context = symbol === undefined ? unit.syntax?.context : undefined;
	return {
		...(symbol === undefined ? {} : { symbol }),
		...(symbol === undefined || unit.qualifiedName === undefined ? {} : { qualifiedSymbol: unit.qualifiedName }),
		...(enclosing === undefined ? {} : { enclosingSymbol: enclosing }),
		...(context === undefined ? {} : { context }),
		...(unit.signature === undefined ? {} : { declaration: unit.signature }),
		...(unit.declarationEndByte === undefined ? {} : { declarationEndByte: unit.declarationEndByte }),
	};
}

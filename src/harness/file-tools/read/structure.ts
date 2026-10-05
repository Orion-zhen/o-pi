import { compareCodeUnitNesting } from "../../code-index/units.ts";
import { codeUnitSymbol } from "../../code-index/unit-context.ts";
import { hasStructuralRange, structureIssues } from "../../code-index/structure.ts";
import type { AnalyzedFileIndex, IndexedCodeUnit } from "../../code-index/types.ts";
import type { ReadStructureContext, ReadStructureSummary } from "./types.ts";

/** 从组合索引选择 read 的有界结构导航。 */
export function readStructureContext(
	analysis: AnalyzedFileIndex,
	range: { startLine: number; endLine: number; partial: boolean },
	maxSymbols: number,
): ReadStructureContext | undefined {
	const result: ReadStructureContext = {};
	if (range.partial) {
		const enclosing = analysis.units.filter((unit) => hasStructuralRange(unit)
			&& unit.startLine < range.startLine && unit.endLine >= range.endLine)
			.sort(compareCodeUnitNesting).map(summary).find((value) => value !== undefined);
		if (enclosing !== undefined) result.enclosing_symbol = enclosing;
	} else if (maxSymbols > 0) {
		const topLevel = analysis.units.filter((unit) => unit.parentId === undefined
			&& (hasStructuralRange(unit) || unit.symbol?.type === "location" && unit.qualifiedName === undefined))
			.map(summary).filter((value) => value !== undefined);
		const visible = topLevel.filter((unit) => range.startLine <= unit.line && unit.line <= range.endLine);
		if (visible.length * 2 <= topLevel.length) {
			const remaining = topLevel.filter((unit) => unit.line < range.startLine || unit.line > range.endLine).slice(0, maxSymbols);
			if (remaining.length > 0) result.remaining_symbols = remaining;
		}
	}
	const errors = analysis.parseErrors?.filter((error) => error.startLine <= range.endLine && error.endLine >= range.startLine
		|| analysis.units.some((unit) => unit.startLine <= range.endLine && unit.endLine >= range.startLine && unit.syntax?.errors.includes(error)));
	if (errors !== undefined && errors.length > 0) result.parse_errors = errors;
	const conflicts = structureIssues(analysis).filter((issue) => issue.kind !== "parse"
		&& issue.range.startLine <= range.endLine && issue.range.endLine >= range.startLine);
	if (conflicts.length > 0) result.conflicts = conflicts;
	return Object.keys(result).length === 0 ? undefined : result;
}

function summary(unit: IndexedCodeUnit): ReadStructureSummary | undefined {
	const name = codeUnitSymbol(unit);
	if (name === undefined) return undefined;
	return {
		name,
		kind: unit.kind, line: unit.startLine,
		end_line: hasStructuralRange(unit) ? unit.endLine : unit.startLine,
	};
}

import type { AnalyzedFileIndex, CodeStructureIssue, IndexedCodeUnit, SourceRange } from "./types.ts";

export function containsRange(outer: SourceRange, inner: SourceRange): boolean {
	return outer.startByte <= inner.startByte && inner.endByte <= outer.endByte;
}

/** 导航位置和错误恢复节点不能作为可靠的包围范围。 */
export function hasStructuralRange(unit: IndexedCodeUnit): boolean {
	return unit.symbol?.type === "document" || unit.syntax !== undefined && unit.syntax.errors.length === 0;
}

export function linkCodeUnits(units: readonly IndexedCodeUnit[]): IndexedCodeUnit[] {
	const ids = new Set(units.map((unit) => unit.id));
	const stack: IndexedCodeUnit[] = [];
	const parents = new Map<string, string>();
	for (const unit of units.filter(hasStructuralRange).sort((a, b) => a.startByte - b.startByte || b.endByte - a.endByte)) {
		while (stack.length > 0) {
			const parent = stack.at(-1);
			if (parent !== undefined && containsRange(parent, unit)
				&& (parent.startByte < unit.startByte || unit.endByte < parent.endByte)) {
				parents.set(unit.id, parent.id);
				break;
			}
			stack.pop();
		}
		if (unit.structureConflict === undefined) stack.push(unit);
	}
	return units.map((unit) => {
		const declaredParent = unit.symbol?.parentId;
		const parentId = declaredParent !== undefined && ids.has(declaredParent) ? declaredParent : parents.get(unit.id);
		const { parentId: _previous, ...value } = unit;
		return { ...value, ...(parentId === undefined ? {} : { parentId }) };
	});
}

/** 同一快照内按声明锚点关联。LSP 范围优先，冲突和歧义保留双方，不按名称猜测。 */
export function mergeCodeStructure(syntax: AnalyzedFileIndex, semantic?: AnalyzedFileIndex): AnalyzedFileIndex {
	if (semantic === undefined) return syntax;
	const owners = new Map<string, number>();
	const matches = semantic.units.map((unit) => {
		const candidates = syntax.units.filter((candidate) => matchesAnchor(unit, candidate));
		for (const candidate of candidates) owners.set(candidate.id, (owners.get(candidate.id) ?? 0) + 1);
		return { unit, candidates };
	});
	const consumed = new Map<string, string>();
	const conflicts = new Map<string, "range" | "ambiguous">();
	const units = matches.map(({ unit, candidates }): IndexedCodeUnit => {
		const candidate = candidates[0];
		if (candidate === undefined) return unit;
		if (candidates.length !== 1 || owners.get(candidate.id) !== 1) {
			for (const candidate of candidates) conflicts.set(candidate.id, "ambiguous");
			return { ...unit, structureConflict: "ambiguous" };
		}
		if (unit.symbol?.type === "document" && candidate.syntax?.body !== undefined
			&& !containsRange(unit, candidate.syntax.body)) {
			conflicts.set(candidate.id, "range");
			return { ...unit, structureConflict: "range" };
		}
		consumed.set(candidate.id, unit.id);
		return {
			...candidate, ...unit,
			...(unit.symbol?.type === "location" ? candidate.syntax?.range : {}),
			...(candidate.signature === undefined ? {} : { signature: candidate.signature }),
			...(candidate.declarationEndByte === undefined ? {} : { declarationEndByte: candidate.declarationEndByte }),
		};
	});
	for (const unit of syntax.units) {
		if (consumed.has(unit.id)) continue;
		const conflict = conflicts.get(unit.id);
		units.push(conflict === undefined ? unit : { ...unit, structureConflict: conflict });
	}
	return {
		...syntax, status: semantic.status,
		units: linkCodeUnits(units).sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte || a.id.localeCompare(b.id)),
		...(syntax.callSites === undefined ? {} : { callSites: syntax.callSites.map((call) => ({
			...call,
			...(call.ownerId === undefined ? {} : { ownerId: consumed.get(call.ownerId) ?? call.ownerId }),
		})) }),
	};
}

export function structureIssues(analysis: AnalyzedFileIndex): CodeStructureIssue[] {
	const issues: CodeStructureIssue[] = (analysis.parseErrors ?? []).map((range) => ({ path: analysis.path, kind: "parse", range }));
	for (const unit of analysis.units) {
		if (unit.structureConflict === undefined) continue;
		issues.push({ path: analysis.path, kind: unit.structureConflict, range: {
			startByte: unit.startByte, endByte: unit.endByte, startLine: unit.startLine, endLine: unit.endLine,
		} });
	}
	return issues;
}

function matchesAnchor(semantic: IndexedCodeUnit, candidate: IndexedCodeUnit): boolean {
	const symbol = semantic.symbol;
	const syntax = candidate.syntax;
	if (symbol === undefined || syntax === undefined || syntax.errors.length > 0) return false;
	const anchor = symbol.type === "document" ? symbol.selection : symbol.range;
	if (syntax.nameRange !== undefined) {
		return containsRange(anchor, syntax.nameRange) || containsRange(syntax.nameRange, anchor);
	}
	if (symbol.type !== "document" || syntax.body === undefined) return false;
	// TypeScript 服务的匿名回调 selectionRange 可以覆盖整个函数，而非仅声明头。
	if (syntax.callable === true && symbol.range.startByte === syntax.range.startByte && symbol.range.endByte === syntax.range.endByte) return true;
	return syntax.range.startByte <= anchor.startByte && anchor.endByte <= syntax.body.startByte;
}

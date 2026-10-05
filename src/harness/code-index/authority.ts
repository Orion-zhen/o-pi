import type { CodeRelation, CodeRelationLocation } from "./relation-types.ts";
import type { AnalyzedFileIndex, CodeAuthority, CodeNavigation, IndexedCodeUnit } from "./types.ts";
import { containsRange } from "./structure.ts";
import { matchesDeclaration } from "./units.ts";

/** 去重并保留同一调用点的多目标歧义。 */
export function normalizeRelationEvidence(relations: readonly CodeRelation[]): CodeRelation[] {
	const unique = [...new Map(relations.map((relation) => [JSON.stringify(relation), relation])).values()];
	const targets = new Map<string, Set<string>>();
	const siteKey = (site: CodeRelationLocation) => `${site.path}\0${site.hash}\0${site.range.startByte}\0${site.range.endByte}`;
	for (const relation of unique) {
		if (relation.kind !== "call" || relation.site === undefined) continue;
		const key = siteKey(relation.site);
		const values = targets.get(key) ?? new Set<string>();
		for (const target of relation.targets) values.add(JSON.stringify([target.uri, target.range]));
		targets.set(key, values);
	}
	return unique.map((relation) => relation.kind === "call" && relation.site !== undefined
		&& (targets.get(siteKey(relation.site))?.size ?? 0) > 1 ? { ...relation, resolution: "ambiguous" } : relation);
}

/** 等级和导航只由关系证据派生，不根据同名符号或导入猜测目标。 */
export function applyRelationEvidence(analysis: AnalyzedFileIndex, relations: readonly CodeRelation[], hash: string): AnalyzedFileIndex {
	relations = relations.filter((relation) => {
		const locations = relation.kind === "reference" ? [relation.site, relation.target]
			: [relation.site, relation.caller, ...relation.targets.flatMap((target) => target.status === "ok" ? [target.location] : [])];
		return locations.every((location) => location === undefined || location.path !== analysis.path || location.hash === hash);
	});
	return { ...analysis, units: analysis.units.map((unit) => {
		let authority: CodeAuthority = "defined";
		const navigation: CodeNavigation[] = [];
		for (const relation of relations) {
			if (relation.kind === "reference") {
				if (!matchesUnit(relation.target, unit) || !outsideUnit(relation.site, unit)) continue;
				if (authority !== "called") authority = "referenced";
				navigation.push(navigate("reference", "references", relation.site));
				continue;
			}
			const caller = relation.caller ?? relation.site;
			const targetMatches = relation.targets.some((target) => target.status === "ok" && target.binding === "callable" && matchesUnit(target.location, unit));
			if (targetMatches && caller !== undefined && outsideUnit(caller, unit)) {
				if (relation.resolution === "resolved" && relation.status === "ok") authority = "called";
				if (relation.site !== undefined && relation.source !== "syntax") {
					navigation.push(navigate("caller", relation.source, relation.site, relation.resolution === "ambiguous"));
				}
			}
			if (caller === undefined || !matchesUnit(caller, unit) || relation.source === "syntax") continue;
			for (const target of relation.targets) {
				if (target.status !== "ok" || target.binding !== "callable") continue;
				navigation.push(navigate("callee", relation.source, target.location, relation.resolution === "ambiguous"));
			}
		}
		const { navigation: _previous, ...base } = unit;
		return { ...base, authority, ...(navigation.length === 0 ? {} : { navigation }) };
	}) };
}

function matchesUnit(location: CodeRelationLocation, unit: IndexedCodeUnit): boolean {
	if (location.path !== unit.path) return false;
	return location.unitId === unit.id || matchesDeclaration(unit, location.range);
}

function outsideUnit(location: CodeRelationLocation, unit: IndexedCodeUnit): boolean {
	if (location.path !== unit.path) return true;
	if (location.unitId !== undefined) return !matchesUnit(location, unit);
	return !containsRange(unit, location.range);
}

function navigate(kind: CodeNavigation["kind"], source: CodeNavigation["source"], location: CodeRelationLocation, ambiguous = false): CodeNavigation {
	return { kind, source, path: location.path, line: location.line, column: location.column, ...(ambiguous ? { ambiguous: true } : {}) };
}

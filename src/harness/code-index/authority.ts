import type { CodeRelation, CodeRelationLocation } from "./relation-types.ts";
import type { AnalyzedFileIndex, CodeAuthority, CodeNavigation, IndexedCodeUnit } from "./types.ts";
import { containsRange } from "./structure.ts";
import { declarationAnchor, matchesDeclaration } from "./units.ts";

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

/** 按声明位置分发关系，保留每个单元原有的证据顺序。 */
export function applyRelationEvidence(analysis: AnalyzedFileIndex, relations: readonly CodeRelation[], hash: string): AnalyzedFileIndex {
	const states = analysis.units.map((unit) => ({ unit, authority: "defined" as CodeAuthority, navigation: [] as CodeNavigation[] }));
	type Evidence = (typeof states)[number];
	const byId = new Map(states.map((state) => [state.unit.id, state]));
	const byStart = new Map<number, Evidence[]>();
	for (const state of states) {
		const { unit } = state;
		for (const start of new Set([declarationAnchor(unit)?.startByte, unit.syntax?.range.startByte])) {
			if (start === undefined) continue;
			const bucket = byStart.get(start) ?? [];
			bucket.push(state);
			byStart.set(start, bucket);
		}
	}
	const matching = (location: CodeRelationLocation): Set<Evidence> => {
		const matches = new Set<Evidence>();
		if (location.path !== analysis.path) return matches;
		const identified = location.unitId === undefined ? undefined : byId.get(location.unitId);
		if (identified !== undefined) matches.add(identified);
		for (const state of byStart.get(location.range.startByte) ?? []) {
			if (matchesDeclaration(state.unit, location.range)) matches.add(state);
		}
		return matches;
	};
	for (const relation of relations) {
		const locations = relation.kind === "reference" ? [relation.site, relation.target]
			: [relation.site, relation.caller, ...relation.targets.flatMap((target) => target.status === "ok" ? [target.location] : [])];
		if (locations.some((location) => location !== undefined && location.path === analysis.path && location.hash !== hash)) continue;
		if (relation.kind === "reference") {
			for (const state of matching(relation.target)) {
				if (!outsideUnit(relation.site, state.unit)) continue;
				if (state.authority !== "called") state.authority = "referenced";
				state.navigation.push(navigate("reference", "references", relation.site));
			}
			continue;
		}
		const caller = relation.caller ?? relation.site;
		if (caller === undefined) continue;
		const targets = relation.targets.flatMap((target) => target.status === "ok" && target.binding === "callable" ? [target.location] : []);
		const incoming = new Set(targets.flatMap((target) => [...matching(target)]));
		for (const state of incoming) {
			if (!outsideUnit(caller, state.unit)) continue;
			if (relation.resolution === "resolved" && relation.status === "ok") state.authority = "called";
			if (relation.site !== undefined && relation.source !== "syntax") {
				state.navigation.push(navigate("caller", relation.source, relation.site, relation.resolution === "ambiguous"));
			}
		}
		if (relation.source === "syntax") continue;
		for (const state of matching(caller)) {
			for (const target of targets) {
				state.navigation.push(navigate("callee", relation.source, target, relation.resolution === "ambiguous"));
			}
		}
	}
	return { ...analysis, units: states.map((state) => {
		const { navigation: _previous, ...base } = state.unit;
		return { ...base, authority: state.authority, ...(state.navigation.length === 0 ? {} : { navigation: state.navigation }) };
	}) };
}

function matchesUnit(location: CodeRelationLocation, unit: IndexedCodeUnit): boolean {
	return location.path === unit.path && (location.unitId === unit.id || matchesDeclaration(unit, location.range));
}

function outsideUnit(location: CodeRelationLocation, unit: IndexedCodeUnit): boolean {
	if (location.path !== unit.path) return true;
	if (location.unitId !== undefined) return !matchesUnit(location, unit);
	return !containsRange(unit, location.range);
}

function navigate(kind: CodeNavigation["kind"], source: CodeNavigation["source"], location: CodeRelationLocation, ambiguous = false): CodeNavigation {
	return { kind, source, path: location.path, line: location.line, column: location.column, ...(ambiguous ? { ambiguous: true } : {}) };
}

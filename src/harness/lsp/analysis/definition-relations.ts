import type { AnalyzedFileIndex, CodeAnalysisStatus, IndexedCodeUnit } from "../../code-index/types.ts";
import type { CodeCallRelation, CodeRelation } from "../../code-index/relation-types.ts";
import { containsRange } from "../../code-index/structure.ts";
import type { LspDocumentSession } from "../client/document-session.ts";
import { combinedStatus, type AnalysisRequests } from "./requests.ts";
import type { RelationLocations } from "./relation-locations.ts";
import { resolution } from "./symbol-relations.ts";

const DEFINITION_LIMIT = 16;

/** 只解析调用点，不对回调传参、变量赋值或动态表达式做数据流推断。 */
export async function definitionRelations(session: LspDocumentSession, analysis: AnalyzedFileIndex, selected: readonly IndexedCodeUnit[], hierarchy: readonly CodeRelation[], locations: RelationLocations, requests: AnalysisRequests) {
	const relations: CodeCallRelation[] = [];
	const statuses = new Map<string, CodeAnalysisStatus[]>();
	const owners = new Map(analysis.units.map((unit) => [unit.id, unit]));
	let queried = 0;
	for (const call of analysis.callSites ?? []) {
		if (selected.length > 0 && !selected.some((unit) => containsRange(unit, call))) continue;
		if (hierarchy.some((relation) => relation.kind === "call" && relation.source === "hierarchy" && relation.site?.path === analysis.path
			&& containsRange(call, relation.site.range) && relation.status === "ok")) continue;
		const site = locations.local(call.callee, call.ownerId);
		const owner = call.ownerId === undefined ? undefined : owners.get(call.ownerId);
		const caller = owner === undefined ? undefined : locations.local(owner.syntax?.nameRange ?? owner, owner.id);
		const base = { kind: "call" as const, site, ...(caller === undefined ? {} : { caller }) };
		const position = call.lookupByte === undefined ? undefined : locations.current.index.positionForByte(call.lookupByte);
		const parseError = (analysis.parseErrors ?? []).some((error) => error.startByte <= call.endByte && call.startByte <= error.endByte);
		const result = position === undefined || parseError || queried >= DEFINITION_LIMIT
			? { status: "skipped" as const }
			: await requests.run(session.capabilities()?.definitionProvider, (options) => {
				queried += 1;
				return session.definition(position, options);
			});
		if (call.ownerId !== undefined) {
			const values = statuses.get(call.ownerId) ?? [];
			values.push(result.status);
			statuses.set(call.ownerId, values);
		}
		if (result.status !== "ok") {
			relations.push({ ...base, source: "syntax", targets: [], status: result.status, resolution: "unknown" });
			continue;
		}
		const candidates = result.value.map((value) => "targetUri" in value
			? { uri: value.targetUri, range: value.targetSelectionRange }
			: value);
		const unique = new Map(candidates.map((value) => [JSON.stringify([value.uri, value.range]), value]));
		const targets = [];
		for (const candidate of unique.values()) targets.push(await locations.target(candidate.uri, candidate.range, false));
		relations.push({ ...base, source: "definition", targets, status: "ok", resolution: resolution(targets) });
	}
	return { relations, statuses: new Map([...statuses].map(([id, values]) => [id, combinedStatus(values)])) };
}

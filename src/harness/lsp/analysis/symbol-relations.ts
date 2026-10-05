import pLimit from "p-limit";
import type { CallHierarchyItem, Position } from "vscode-languageserver-protocol";
import type { CodeAnalysisStatus, CodeRelationStatus, IndexedCodeUnit } from "../../code-index/types.ts";
import type { CodeCallRelation, CodeRelation, CodeRelationTarget } from "../../code-index/relation-types.ts";
import type { LspDocumentSession } from "../client/document-session.ts";
import { combinedStatus, type AnalysisRequests } from "./requests.ts";
import { queryAnchor } from "../../code-index/units.ts";
import type { RelationLocations } from "./relation-locations.ts";

export interface SymbolRelations {
	readonly relations: readonly CodeRelation[];
	readonly status: Pick<CodeRelationStatus, "incomingCalls" | "outgoingCalls" | "references">;
}

/** 准备全部候选，传入、传出和引用请求独立保留成功结果。 */
export async function symbolRelations(session: LspDocumentSession, position: Position, unit: IndexedCodeUnit, locations: RelationLocations, requests: AnalysisRequests): Promise<SymbolRelations> {
	const capabilities = session.capabilities();
	const [prepared, references] = await Promise.all([
		requests.run(capabilities?.callHierarchyProvider, (options) => session.prepareCalls(position, options)),
		requests.run(capabilities?.referencesProvider, (options) => session.references(position, options)),
	]);
	const relations: CodeRelation[] = [];
	const incoming: CodeAnalysisStatus[] = [];
	const outgoing: CodeAnalysisStatus[] = [];
	if (prepared.status === "ok") {
		const limit = pLimit(2);
		const results = await Promise.all(prepared.value.map((item) => limit(async () => {
			const [calls, callees] = await Promise.all([
				requests.run(true, (options) => session.incomingCalls(item, options)),
				requests.run(true, (options) => session.outgoingCalls(item, options)),
			]);
			return { item, calls, callees };
		})));
		for (const { item, calls, callees } of results) {
			incoming.push(calls.status);
			outgoing.push(callees.status);
			if (calls.status === "ok") for (const call of calls.value) {
				relations.push(...await hierarchyRelations(call.from, item, call.fromRanges, locations, prepared.value.length > 1));
			}
			if (callees.status === "ok") for (const call of callees.value) {
				relations.push(...await hierarchyRelations(item, call.to, call.fromRanges, locations, prepared.value.length > 1));
			}
		}
	}
	if (references.status === "ok") {
		const target = locations.local(queryAnchor(unit), unit.id);
		for (const reference of references.value) {
			const site = await locations.location(reference.uri, reference.range);
			if (site !== undefined) relations.push({ kind: "reference", source: "references", site, target });
		}
	}
	return {
		relations,
		status: {
			incomingCalls: prepared.status === "ok" ? combinedStatus(incoming) : prepared.status,
			outgoingCalls: prepared.status === "ok" ? combinedStatus(outgoing) : prepared.status,
			references: references.status,
		},
	};
}

async function hierarchyRelations(caller: CallHierarchyItem, target: CallHierarchyItem, ranges: CallHierarchyItem["range"][], locations: RelationLocations, ambiguous: boolean): Promise<CodeCallRelation[]> {
	const from = await locations.location(caller.uri, caller.selectionRange);
	const to = await locations.target(target.uri, target.selectionRange, true);
	const sites = await Promise.all(ranges.map((range) => locations.location(caller.uri, range)));
	const base = {
		kind: "call" as const, source: "hierarchy" as const,
		targets: [to],
		status: to.status === "ok" && from !== undefined ? "ok" as const : "unavailable" as const,
		resolution: ambiguous ? "ambiguous" as const : resolution([to]),
		...(from === undefined ? {} : { caller: from }),
	};
	if (sites.length === 0) return [base];
	return sites.map((site) => site === undefined ? { ...base, status: "unavailable" } : { ...base, site });
}

export function resolution(targets: readonly CodeRelationTarget[]): CodeCallRelation["resolution"] {
	if (targets.length > 1) return "ambiguous";
	const target = targets[0];
	return target?.status !== "ok" ? "unknown" : target.binding === "callable" ? "resolved" : "indirect";
}


import type { IndexedCodeUnit } from "../../code-index/parser.js";
import { resolveTextRange } from "../../filesystem/services/text.js";
import { fail, type ToolOutcome } from "../shared/result.js";
import {
	createSemanticCodeRegion,
	normalizeMatchedBy,
	type CandidateRole,
	type CandidateSignal,
	type CodeRegion,
	type RegionEvidence,
	type RetrievalSource,
	type SemanticMainRegion,
	type VerifiedCodeRegion,
} from "./candidates.js";
import type { ScopeInventory } from "./inventory.js";
import type { LocalAutoResult } from "./local.js";
import type { GrepHintSource, GrepPositionHint } from "./ports.js";
import type { QueryPlan, RelationIntent } from "./query-plan.js";
import { assignSourceLocalRanks, classifySymbolMatch, rankCodeRegions } from "./ranking.js";
import type { AutoRegionizedFile } from "./regionizer.js";

export interface GrepHintSources {
	readonly lsp?: GrepHintSource;
	readonly repoMap?: GrepHintSource;
}

interface HintDemand {
	readonly lsp: boolean;
	readonly repoMap: boolean;
}

interface RetrievedHint {
	readonly hint: GrepPositionHint;
	readonly scopeOrder: number;
	readonly channelOrder: number;
	readonly candidateOrder: number;
}

interface MaterializedHint extends RetrievedHint {
	readonly file: AutoRegionizedFile;
	readonly unit: IndexedCodeUnit;
	readonly source: RetrievalSource;
	readonly roles: readonly CandidateRole[];
	readonly signals: readonly CandidateSignal[];
}

const RELATION_ROLE: Readonly<Partial<Record<string, Extract<CandidateRole,
	"caller" | "callee" | "reference" | "test" | "import" | "registration" | "entrypoint">>>> = {
	caller: "caller",
	callee: "callee",
	reference: "reference",
	test: "test",
	import: "import",
	registration: "registration",
	entrypoint: "entrypoint",
};

/** 只在本地候选不足或精确符号存在歧义时请求位置提示。 */
export function grepHintDemand(plan: QueryPlan, local: LocalAutoResult): HintDemand {
	if (plan.match !== "auto") return { lsp: false, repoMap: false };
	if (plan.relationIntents.length > 0) {
		const requested = new Set(plan.relationIntents);
		const hasLocalRelation = local.regions.some((region) =>
			region.evidence.some((item) => item.source === "ast-relation")
			&& region.roles.some((role) => requested.has(role as RelationIntent)));
		return hasLocalRelation ? { lsp: false, repoMap: false } : { lsp: true, repoMap: true };
	}
	if (plan.shape === "identifier" || plan.shape === "qualified_symbol") {
		const exactDefinitions = local.regions.filter((region) =>
			region.roles.includes("definition")
			&& region.signals.some((signal) =>
				signal === "exact_symbol_definition"
				|| signal === "exact_qualified_definition"
				|| signal === "exact_member_definition"));
		if (exactDefinitions.length > 1) return { lsp: true, repoMap: false };
		if (local.ranked.length === 0) return { lsp: false, repoMap: true };
		return { lsp: false, repoMap: false };
	}
	return {
		lsp: false,
		repoMap: plan.shape === "natural_language" && local.ranked.length === 0,
	};
}

/** 根据 demand 查询提示；提示失败不影响本地 grep，取消仍沿调用链传播。 */
export async function queryGrepHints(
	inventory: ScopeInventory,
	plan: QueryPlan,
	sources: GrepHintSources,
	demand: HintDemand,
	signal: AbortSignal | undefined,
	resultLimit: number,
): Promise<ToolOutcome<readonly RetrievedHint[]>> {
	if (isAborted(signal)) return aborted();
	const query = plan.targetQuery.length === 0 ? plan.query : plan.targetQuery;
	const requests = inventory.scopes.flatMap((scope) => {
		const allowedPaths = inventory.files
			.filter((file) => file.memberships.some((membership) => membership.scopeOrder === scope.order))
			.map((file) => file.path);
		const input = {
			root: scope.root,
			query,
			allowedPaths,
			limit: Math.max(24, resultLimit * 6),
			...(plan.relationIntents.length === 0 ? {} : { relationQuery: true }),
			...(signal === undefined ? {} : { signal }),
		};
		return [
			...(demand.lsp && sources.lsp !== undefined
				? [settleHintSource(() => sources.lsp?.query(input), signal)
					.then((hints) => ({ scopeOrder: scope.order, channelOrder: 0, hints }))]
				: []),
			...(demand.repoMap && sources.repoMap !== undefined
				? [settleHintSource(() => sources.repoMap?.query(input), signal)
					.then((hints) => ({ scopeOrder: scope.order, channelOrder: 1, hints }))]
				: []),
		];
	});
	const batches = await Promise.all(requests);
	if (isAborted(signal)) return aborted();
	const retrieved: RetrievedHint[] = [];
	for (const batch of batches.sort((left, right) =>
		left.scopeOrder - right.scopeOrder || left.channelOrder - right.channelOrder)) {
		for (const [candidateOrder, hint] of batch.hints.entries()) {
			retrieved.push({
				hint,
				scopeOrder: batch.scopeOrder,
				channelOrder: batch.channelOrder,
				candidateOrder,
			});
		}
	}
	return dedupeHints(retrieved);
}

/**
 * 提示必须映射到本次已读取并解析的 live AST unit。公开区域的路径、范围、符号和
 * declaration 全部来自该 unit，外部元数据只能增加内部排名证据。
 */
export function applyGrepHints(
	plan: QueryPlan,
	local: LocalAutoResult,
	files: readonly AutoRegionizedFile[],
	retrieved: readonly RetrievedHint[],
): LocalAutoResult {
	const filesByPath = new Map(files.map((file) => [file.file.path, file]));
	const materialized = retrieved.flatMap((item) => {
		const value = materializeHint(plan, filesByPath.get(item.hint.path), item);
		return value === undefined ? [] : [value];
	});
	const ranks = assignSourceLocalRanks(materialized, (item) => item.source, compareMaterializedHints);
	const regions = new Map(local.regions.map((region) => [region.id, region]));
	for (const item of materialized) {
		const incoming = regionFromHint(item, ranks.get(item) ?? Number.MAX_SAFE_INTEGER);
		const existing = regions.get(incoming.id);
		regions.set(incoming.id, existing === undefined ? incoming : mergeRegion(existing, incoming));
	}
	const values = [...regions.values()];
	const ranked = rankCodeRegions(plan, values);
	return {
		regions: values,
		ranked,
		totalCandidates: ranked.length,
		nearby: ranked.length === 0 ? local.nearby : [],
	};
}

function materializeHint(
	plan: QueryPlan,
	file: AutoRegionizedFile | undefined,
	retrieved: RetrievedHint,
): MaterializedHint | undefined {
	if (file === undefined || !validHint(retrieved.hint)) return undefined;
	if (retrieved.hint.hop === 1 && plan.relationIntents.length === 0) return undefined;
	if (retrieved.hint.contentHash !== undefined
		&& normalizeHash(retrieved.hint.contentHash) !== normalizeHash(file.content.hash)) return undefined;
	const range = resolveTextRange(file.content.text, retrieved.hint.range);
	if (range === undefined) return undefined;
	const unit = file.analysis.index.units
		.filter((candidate) => candidate.startLine <= range.startLine && range.endLine <= candidate.endLine)
		.sort((left, right) => (left.endByte - left.startByte) - (right.endByte - right.startByte)
			|| left.startByte - right.startByte || compareString(left.id, right.id))[0];
	if (unit === undefined) return undefined;
	const relation = normalizedRelation(retrieved.hint);
	const relationRole = relation === undefined ? undefined : RELATION_ROLE[relation];
	if (relationRole !== undefined) {
		if (!plan.relationIntents.includes(relationRole as RelationIntent)) return undefined;
		return {
			...retrieved,
			file,
			unit,
			source: sourceFor(retrieved.hint),
			roles: [relationRole],
			signals: ["requested_relation"],
		};
	}
	const symbolMatch = classifySymbolMatch(plan, unit.name, unit.qualifiedName);
	if (retrieved.hint.origin !== "repo-map") {
		if (symbolMatch !== "exact_symbol_definition"
			&& symbolMatch !== "exact_qualified_definition"
			&& symbolMatch !== "exact_member_definition") return undefined;
	}
	const roles = unitRoles(unit);
	const signals: CandidateSignal[] = symbolMatch === undefined
		? ["direct_symbol"]
		: [symbolMatch];
	return {
		...retrieved,
		file,
		unit,
		source: sourceFor(retrieved.hint),
		roles,
		signals,
	};
}

function regionFromHint(item: MaterializedHint, rank: number): SemanticMainRegion {
	const unit = item.unit;
	const evidence: RegionEvidence[] = [
		{ source: "ast-symbol", rank: 1, confidence: 1, reason: "live AST unit" },
		{
			source: item.source,
			rank,
			confidence: item.hint.confidence,
			...(item.hint.hop === undefined ? {} : { hop: item.hint.hop }),
			reason: item.hint.reasons[0] ?? "position hint",
		},
	];
	return createSemanticCodeRegion({
		id: unit.id,
		path: unit.path,
		startLine: unit.startLine,
		endLine: unit.endLine,
		startByte: unit.startByte,
		endByte: unit.endByte,
		kind: unit.kind,
		...(unit.name === undefined ? {} : { symbol: unit.qualifiedName ?? unit.name }),
		...(unit.qualifiedName === undefined ? {} : { qualifiedSymbol: unit.qualifiedName }),
		...(unit.signature === undefined ? {} : { declaration: unit.signature }),
		...(unit.declarationEndByte === undefined ? {} : { declarationEndByte: unit.declarationEndByte }),
		roles: item.roles,
		signals: item.signals,
		evidence,
	});
}

function mergeRegion(
	existing: CodeRegion,
	incoming: SemanticMainRegion,
): VerifiedCodeRegion | SemanticMainRegion {
	const roles = unique([...existing.roles, ...incoming.roles]);
	const signals = unique([...existing.signals, ...incoming.signals]);
	const evidence = mergeEvidence(existing.evidence, incoming.evidence);
	const matchedBy = normalizeMatchedBy(signals, evidence);
	return { ...existing, roles, signals, evidence, matchedBy };
}

function mergeEvidence(left: readonly RegionEvidence[], right: readonly RegionEvidence[]): RegionEvidence[] {
	const merged = new Map<string, RegionEvidence>();
	for (const item of [...left, ...right]) {
		const key = `${item.source}\0${item.reason}`;
		const existing = merged.get(key);
		if (existing === undefined || item.rank < existing.rank) merged.set(key, item);
	}
	return [...merged.values()];
}

function unitRoles(unit: IndexedCodeUnit): CandidateRole[] {
	const roles: CandidateRole[] = ["definition"];
	if (unit.exported) roles.push("public_api");
	if (/(?:^|\/)(?:test|tests|spec|specs)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$/iu.test(unit.path)) roles.push("test");
	if (/(?:^|\/)(?:config|configs)(?:\/|$)|(?:^|\/)[^/]*config[^/]*\.[^/]+$/iu.test(unit.path)) roles.push("config");
	return roles;
}

function normalizedRelation(hint: GrepPositionHint): string | undefined {
	const relation = hint.relation ?? hint.reasons.find((reason) => Object.hasOwn(RELATION_ROLE, reason));
	if (relation === "calls") return "caller";
	if (relation === "references") return "reference";
	if (relation === "tests") return "test";
	if (relation === "imports") return "import";
	if (relation === "declares-entrypoint" || relation === "declares-script") return "entrypoint";
	if (relation?.startsWith("registers-") === true) return "registration";
	return relation;
}

function sourceFor(hint: GrepPositionHint): RetrievalSource {
	if (hint.origin === "lsp-symbol") return "lsp-symbol";
	if (hint.origin === "lsp-reference") return "lsp-reference";
	return hint.hop === 1 ? "repo-map-hop-1" : "repo-map-direct";
}

function validHint(hint: GrepPositionHint): boolean {
	return hint.path.length > 0
		&& !hint.path.includes("\0")
		&& Number.isFinite(hint.confidence)
		&& hint.confidence >= 0
		&& hint.confidence <= 1
		&& (hint.hop === undefined || hint.hop === 0 || hint.hop === 1);
}

function compareMaterializedHints(left: MaterializedHint, right: MaterializedHint): number {
	return left.scopeOrder - right.scopeOrder
		|| left.channelOrder - right.channelOrder
		|| left.candidateOrder - right.candidateOrder
		|| compareString(left.unit.path, right.unit.path)
		|| left.unit.startLine - right.unit.startLine
		|| compareString(left.unit.id, right.unit.id);
}

function dedupeHints(values: readonly RetrievedHint[]): RetrievedHint[] {
	const result = new Map<string, RetrievedHint>();
	for (const value of values) {
		const hint = value.hint;
		const key = [
			hint.origin,
			hint.path,
			hint.range.startLine,
			hint.range.endLine,
			hint.range.startByte ?? "",
			hint.range.endByte ?? "",
			hint.relation ?? "",
			hint.hop ?? 0,
			hint.contentHash ?? "",
		].join("\0");
		if (!result.has(key)) result.set(key, value);
	}
	return [...result.values()];
}

async function settleHintSource(
	start: () => Promise<readonly GrepPositionHint[]> | undefined,
	signal: AbortSignal | undefined,
): Promise<readonly GrepPositionHint[]> {
	if (isAborted(signal)) return [];
	let pending: Promise<readonly GrepPositionHint[]> | undefined;
	try { pending = start(); } catch { return []; }
	if (pending === undefined) return [];
	const safe = pending.catch(() => [] as readonly GrepPositionHint[]);
	if (signal === undefined) return await safe;
	return await new Promise((resolve) => {
		let settled = false;
		const finish = (value: readonly GrepPositionHint[]): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const onAbort = (): void => finish([]);
		signal.addEventListener("abort", onAbort, { once: true });
		void safe.then(finish);
	});
}

function normalizeHash(value: string): string {
	return value.replace(/^sha256:/u, "").toLocaleLowerCase();
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function compareString(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function aborted(): ReturnType<typeof fail> {
	return fail("OPERATION_ABORTED", "grep was aborted.");
}

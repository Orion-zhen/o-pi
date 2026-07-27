import type { TextContent } from "../../filesystem/contracts/content.js";
import { resolveTextRange } from "../../filesystem/services/text.js";
import type { FsOperationContext } from "../../filesystem/contracts/result.js";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.js";
import { fail, type ToolOutcome } from "../shared/result.js";
import {
	createSemanticCodeRegion,
	type CandidateRole,
	type CandidateSignal,
	type RegionEvidence,
	type RetrievalSource,
	type SemanticMainRegion,
	type VerifiedCodeRegion,
} from "./candidates.js";
import type { InventoryScope, ScopeInventory, ScopedFile } from "./inventory.js";
import type { GrepExternalCandidate, GrepExternalRange, GrepGraphSource, GrepSymbolSource } from "./ports.js";
import type { LocalAutoResult } from "./local.js";
import type { QueryPlan } from "./query-plan.js";
import { assignSourceLocalRanks, rankCodeRegions, selectRankedRegions } from "./ranking.js";
import type { GrepRelatedResult } from "./types.js";

export interface RetrievedExternalCandidate {
	readonly candidate: GrepExternalCandidate;
	readonly scopeOrder: number;
	readonly channelOrder: number;
	readonly candidateOrder: number;
}

export interface ValidatedExternalCandidate extends RetrievedExternalCandidate {
	readonly file: ScopedFile;
	readonly range?: Required<GrepExternalRange>;
	readonly content: TextContent;
	readonly source: RetrievalSource;
	readonly sourceRank: number;
}

export interface ExternalQueryContext {
	readonly symbols?: GrepSymbolSource;
	readonly graph?: GrepGraphSource;
	readonly signal?: AbortSignal;
	readonly resultLimit: number;
}

export interface ExternalValidationContext {
	readonly filesystem: WorkspaceFileSystem;
	readonly operation: FsOperationContext;
}

export interface StrictExternalAugmentation {
	readonly regions: readonly VerifiedCodeRegion[];
	readonly related: readonly GrepRelatedResult[];
}

/** inventory 完成后按输入 scope 并行启动独立增强通道。 */
export async function queryExternalChannels(
	inventory: ScopeInventory,
	plan: QueryPlan,
	context: ExternalQueryContext,
): Promise<readonly RetrievedExternalCandidate[]> {
	const query = plan.targetQuery.length === 0 ? plan.query : plan.targetQuery;
	const requests = inventory.scopes.flatMap((scope) => {
		const allowedPaths = allowedPathsForScope(inventory, scope);
		const input = {
			root: scope.root,
			query,
			allowedPaths,
			limit: Math.max(24, context.resultLimit * 6),
			...(context.signal === undefined ? {} : { signal: context.signal }),
		};
		return [
			settleExternal(context.symbols === undefined ? undefined : () => context.symbols?.query(input), context.signal)
				.then((candidates) => ({ scope, channelOrder: 0, candidates })),
			settleExternal(context.graph === undefined ? undefined : () => context.graph?.query(input), context.signal)
				.then((candidates) => ({ scope, channelOrder: 1, candidates })),
		];
	});
	const batches = await Promise.all(requests);
	const result: RetrievedExternalCandidate[] = [];
	for (const batch of batches.sort((left, right) => left.scope.order - right.scope.order || left.channelOrder - right.channelOrder)) {
		for (const [candidateOrder, candidate] of batch.candidates.entries()) {
			result.push({ candidate, scopeOrder: batch.scope.order, channelOrder: batch.channelOrder, candidateOrder });
		}
	}
	return dedupeRetrieved(result);
}

/** 所有外部 lane 共用同一 live filesystem 验证边界。 */
export async function validateExternalCandidates(
	inventory: ScopeInventory,
	candidates: readonly RetrievedExternalCandidate[],
	context: ExternalValidationContext,
): Promise<ToolOutcome<readonly ValidatedExternalCandidate[]>> {
	if (isAborted(context.operation.signal)) return aborted();
	const files = new Map(inventory.files.map((file) => [file.path, file]));
	const loaded = new Map<string, Promise<TextContent | undefined>>();
	const provisional: Array<Omit<ValidatedExternalCandidate, "sourceRank">> = [];
	for (const retrieved of candidates) {
		if (isAborted(context.operation.signal)) return aborted();
		const file = files.get(retrieved.candidate.path);
		if (file === undefined || !validCandidateShape(retrieved.candidate)) continue;
		let pending = loaded.get(file.path);
		if (pending === undefined) {
			pending = loadCurrentFile(file, context);
			loaded.set(file.path, pending);
		}
		const content = await pending;
		if (isAborted(context.operation.signal)) return aborted(file.path);
		if (content === undefined || !matchesExternalVersion(retrieved.candidate, file, content)) continue;
		const range = validateRange(retrieved.candidate.range, content);
		if (retrieved.candidate.range !== undefined && range === undefined) continue;
		provisional.push({
			...retrieved,
			file,
			...(range === undefined ? {} : { range }),
			content,
			source: retrievalSource(retrieved.candidate),
		});
	}
	const ranks = assignSourceLocalRanks(provisional, (candidate) => candidate.source, compareExternalSourceOrder);
	return provisional.map((candidate) => ({
		...candidate,
		sourceRank: ranks.get(candidate) ?? Number.MAX_SAFE_INTEGER,
	}));
}

/** strict 外部候选只能给事实主区域增加证据，不能创建 main。 */
export function augmentStrictWithExternal(
	regions: readonly VerifiedCodeRegion[],
	candidates: readonly ValidatedExternalCandidate[],
): StrictExternalAugmentation {
	const main = new Map(regions.map((region) => [region.id, region]));
	const related: GrepRelatedResult[] = [];
	for (const candidate of candidates) {
		const matching = findMatchingRegion(main.values(), candidate);
		if (matching === undefined) {
			related.push(toRelated(candidate));
			continue;
		}
		main.set(matching.id, mergeEvidence(matching, candidateEvidence(candidate), candidateRole(candidate), []));
	}
	return { regions: [...main.values()], related: dedupeRelated(related) };
}

/** 将已统一验证的增强候选融入 auto；lane 决策只依赖 QueryPlan 和候选关系。 */
export function augmentAutoWithExternal(
	plan: QueryPlan,
	local: LocalAutoResult,
	candidates: readonly ValidatedExternalCandidate[],
): LocalAutoResult {
	const main = new Map<string, VerifiedCodeRegion | SemanticMainRegion>();
	for (const region of local.regions) if (region.lane === "main") main.set(region.id, region);
	const related = [...local.related];
	const sourceText = new Map(local.sourceText);
	for (const candidate of candidates) {
		sourceText.set(candidate.file.path, candidate.content.text);
		const role = candidateRole(candidate);
		if (!eligibleForAutoMain(plan, candidate, role) || candidate.range === undefined) {
			related.push(toRelated(candidate));
			continue;
		}
		const existing = findMatchingRegion(main.values(), candidate);
		const signals = candidateSignals(plan, candidate, role);
		if (existing !== undefined) {
			main.set(existing.id, mergeEvidence(existing, candidateEvidence(candidate), role, signals));
			continue;
		}
		const raw = candidate.candidate;
		const region = createSemanticCodeRegion({
			id: externalRegionId(candidate),
			path: raw.path,
			startLine: candidate.range.startLine,
			endLine: candidate.range.endLine,
			startByte: candidate.range.startByte,
			endByte: candidate.range.endByte,
			kind: raw.kind ?? (role.includes("definition") ? "symbol" : "region"),
			...(raw.qualifiedSymbol ?? raw.symbol ? { symbol: raw.qualifiedSymbol ?? raw.symbol } : {}),
			...(raw.qualifiedSymbol === undefined ? {} : { qualifiedSymbol: raw.qualifiedSymbol }),
			...(raw.signature === undefined ? {} : { signature: raw.signature }),
			roles: role,
			signals,
			evidence: candidateEvidence(candidate),
			lane: "main",
		});
		if (region.lane === "main") main.set(region.id, region);
	}
	const regions = [...main.values()];
	const allRanked = rankCodeRegions(plan, regions);
	const ranked = selectRankedRegions(allRanked, allRanked.length);
	return {
		...local,
		regions,
		ranked,
		totalCandidates: allRanked.length,
		sourceText,
		nearby: ranked.length === 0 ? local.nearby : [],
		related: dedupeRelated(related),
	};
}

const RELATION_ROLES = new Set<CandidateRole>(["caller", "callee", "reference", "test", "import", "registration"]);
const DIRECT_REPO_REASONS = new Set([
	"exact qualified symbol", "exact symbol", "short symbol", "signature", "alias", "definition", "export",
	"public api", "entrypoint", "registration", "package", "component",
]);

function eligibleForAutoMain(
	plan: QueryPlan,
	candidate: ValidatedExternalCandidate,
	roles: readonly CandidateRole[],
): boolean {
	if (candidate.range === undefined) return false;
	const relationRole = roles.find((role) => RELATION_ROLES.has(role));
	if (relationRole !== undefined) return plan.relationIntents.includes(relationRole as typeof plan.relationIntents[number]);
	if (candidate.candidate.origin === "lsp-symbol") return true;
	return candidate.candidate.origin === "repo-map"
		&& (candidate.candidate.hop ?? 0) === 0
		&& candidate.candidate.reasons.some((reason) => DIRECT_REPO_REASONS.has(reason));
}

function candidateRole(candidate: ValidatedExternalCandidate): CandidateRole[] {
	const relation = normalizedRelation(candidate.candidate);
	if (relation === "caller" || relation === "callee" || relation === "reference" || relation === "test"
		|| relation === "import" || relation === "registration") return [relation];
	const roles: CandidateRole[] = ["definition"];
	if (candidate.candidate.reasons.some((reason) => reason === "public api" || reason === "export" || reason === "entrypoint")) roles.push("public_api");
	if (/(?:^|\/)(?:test|tests|spec|specs)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$/iu.test(candidate.candidate.path)) roles.push("test");
	if (/(?:^|\/)(?:config|configs)(?:\/|$)|(?:^|\/)[^/]*config[^/]*\.[^/]+$/iu.test(candidate.candidate.path)) roles.push("config");
	return roles;
}

function candidateSignals(
	plan: QueryPlan,
	candidate: ValidatedExternalCandidate,
	roles: readonly CandidateRole[],
): CandidateSignal[] {
	if (roles.some((role) => RELATION_ROLES.has(role))
		&& roles.some((role) => plan.relationIntents.includes(role as typeof plan.relationIntents[number]))) return ["requested_relation"];
	if (candidate.candidate.origin === "repo-map" && candidate.candidate.reasons.some((reason) => reason === "alias" || reason === "component" || reason === "package")) {
		return ["repo_summary"];
	}
	return ["direct_symbol"];
}

function normalizedRelation(candidate: GrepExternalCandidate): string | undefined {
	if (candidate.relation !== undefined) return candidate.relation;
	return candidate.reasons.find((reason) => reason === "caller" || reason === "callee" || reason === "reference"
		|| reason === "test" || reason === "import" || reason === "registration");
}

function candidateEvidence(candidate: ValidatedExternalCandidate): RegionEvidence[] {
	const reasons = candidate.candidate.reasons.length === 0 ? [candidate.candidate.origin] : candidate.candidate.reasons;
	return reasons.map((reason) => ({
		source: candidate.source,
		rank: candidate.sourceRank,
		confidence: candidate.candidate.confidence,
		...(candidate.candidate.hop === undefined ? {} : { hop: candidate.candidate.hop }),
		reason,
	}));
}

function findMatchingRegion<T extends VerifiedCodeRegion | SemanticMainRegion>(
	regions: Iterable<T>,
	candidate: ValidatedExternalCandidate,
): T | undefined {
	const range = candidate.range;
	if (range === undefined) return undefined;
	const symbol = candidate.candidate.qualifiedSymbol ?? candidate.candidate.symbol;
	const matches = [...regions].filter((region) => {
		if (region.path !== candidate.candidate.path) return false;
		if (candidate.candidate.signature !== undefined && region.signature !== undefined
			&& candidate.candidate.signature !== region.signature) return false;
		if (symbol !== undefined && region.symbol !== undefined && !sameSymbol(symbol, region.symbol)) return false;
		const exactRange = region.startLine === range.startLine && region.endLine === range.endLine;
		const enclosing = region.startLine <= range.startLine && range.endLine <= region.endLine;
		return exactRange || (symbol !== undefined && enclosing);
	});
	return matches.sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine)
		|| compareString(left.id, right.id))[0];
}

function mergeEvidence<T extends VerifiedCodeRegion | SemanticMainRegion>(
	region: T,
	evidence: readonly RegionEvidence[],
	roles: readonly CandidateRole[],
	signals: readonly CandidateSignal[],
): T {
	const merged = new Map<string, RegionEvidence>();
	for (const item of [...region.evidence, ...evidence]) {
		const key = `${item.source}\0${item.reason}`;
		const existing = merged.get(key);
		if (existing === undefined || item.rank < existing.rank) merged.set(key, item);
	}
	return {
		...region,
		roles: unique([...region.roles, ...roles]),
		signals: unique([...region.signals, ...signals]),
		evidence: [...merged.values()],
	};
}

function toRelated(candidate: ValidatedExternalCandidate): GrepRelatedResult {
	const raw = candidate.candidate;
	const relation = normalizedRelation(raw);
	return {
		path: raw.path,
		kind: raw.kind ?? (candidate.range === undefined ? "file" : "region"),
		...(candidate.range === undefined ? {} : { start_line: candidate.range.startLine, end_line: candidate.range.endLine }),
		...(raw.qualifiedSymbol ?? raw.symbol ? { symbol: raw.qualifiedSymbol ?? raw.symbol } : {}),
		...(raw.signature === undefined ? {} : { signature: raw.signature }),
		sources: [candidate.source],
		relations: relation === undefined ? (raw.reasons.length === 0 ? ["related"] : [...raw.reasons]) : [relation],
		query_match: "not_guaranteed",
	};
}

function dedupeRelated(values: readonly GrepRelatedResult[]): GrepRelatedResult[] {
	const result = new Map<string, GrepRelatedResult>();
	for (const value of values) {
		const key = [value.path, value.start_line ?? "", value.end_line ?? "", value.symbol ?? "", value.signature ?? "", ...value.relations].join("\0");
		const existing = result.get(key);
		if (existing === undefined) result.set(key, value);
		else result.set(key, { ...existing, sources: unique([...existing.sources, ...value.sources]) });
	}
	return [...result.values()].sort((left, right) => compareString(left.path, right.path)
		|| (left.start_line ?? 0) - (right.start_line ?? 0)
		|| compareString(left.symbol ?? "", right.symbol ?? ""));
}

function compareExternalSourceOrder(
	left: Omit<ValidatedExternalCandidate, "sourceRank">,
	right: Omit<ValidatedExternalCandidate, "sourceRank">,
): number {
	return left.scopeOrder - right.scopeOrder
		|| left.channelOrder - right.channelOrder
		|| left.candidateOrder - right.candidateOrder
		|| compareString(left.candidate.path, right.candidate.path)
		|| (left.range?.startLine ?? 0) - (right.range?.startLine ?? 0)
		|| compareString(left.candidate.symbol ?? "", right.candidate.symbol ?? "");
}

function externalRegionId(candidate: ValidatedExternalCandidate): string {
	const raw = candidate.candidate;
	const range = candidate.range;
	return ["external", raw.path, range?.startLine ?? 0, range?.endLine ?? 0, raw.qualifiedSymbol ?? raw.symbol ?? "", raw.signature ?? ""].join(":");
}

function sameSymbol(left: string, right: string): boolean {
	const normalize = (value: string): string => value.toLocaleLowerCase().split(/[.:#]/u).at(-1) ?? value.toLocaleLowerCase();
	return normalize(left) === normalize(right);
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function compareString(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function allowedPathsForScope(inventory: ScopeInventory, scope: InventoryScope): string[] {
	return inventory.files
		.filter((file) => file.memberships.some((membership) => membership.scopeOrder === scope.order))
		.map((file) => file.path);
}

async function settleExternal(
	start: (() => Promise<readonly GrepExternalCandidate[]> | undefined) | undefined,
	signal: AbortSignal | undefined,
): Promise<readonly GrepExternalCandidate[]> {
	if (start === undefined || signal?.aborted === true) return [];
	let pending: Promise<readonly GrepExternalCandidate[]> | undefined;
	try { pending = start(); }
	catch { return []; }
	if (pending === undefined) return [];
	const safe = pending.catch(() => [] as readonly GrepExternalCandidate[]);
	if (signal === undefined) return await safe;
	return await new Promise((resolve) => {
		let settled = false;
		const finish = (value: readonly GrepExternalCandidate[]): void => {
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

async function loadCurrentFile(file: ScopedFile, context: ExternalValidationContext): Promise<TextContent | undefined> {
	const content = await context.filesystem.content.readText(file.ref, {
		expectedSnapshot: file.snapshot,
		stable: true,
		rejectBinary: true,
	}, context.operation);
	return content.ok ? content.value : undefined;
}

function matchesExternalVersion(candidate: GrepExternalCandidate, file: ScopedFile, content: TextContent): boolean {
	if (candidate.contentVersion !== undefined && candidate.contentVersion !== file.snapshot.version) return false;
	if (candidate.contentHash === undefined) return true;
	return normalizeHash(candidate.contentHash) === normalizeHash(content.hash);
}

function validateRange(range: GrepExternalRange | undefined, content: TextContent): Required<GrepExternalRange> | undefined {
	if (range === undefined) return undefined;
	return resolveTextRange(content.text, range);
}

function validCandidateShape(candidate: GrepExternalCandidate): boolean {
	return typeof candidate.path === "string" && candidate.path.length > 0 && !candidate.path.includes("\0")
		&& Number.isFinite(candidate.confidence) && candidate.confidence >= 0 && candidate.confidence <= 1
		&& (candidate.hop === undefined || candidate.hop === 0 || candidate.hop === 1 || candidate.hop === 2);
}

function retrievalSource(candidate: GrepExternalCandidate): RetrievalSource {
	if (candidate.origin === "lsp-symbol") return "lsp-symbol";
	if (candidate.origin === "lsp-reference") return "lsp-reference";
	return candidate.hop === 1 ? "repo-map-hop-1" : candidate.hop === 2 ? "repo-map-hop-2" : "repo-map-direct";
}

function dedupeRetrieved(values: readonly RetrievedExternalCandidate[]): RetrievedExternalCandidate[] {
	const result = new Map<string, RetrievedExternalCandidate>();
	for (const value of values) {
		const candidate = value.candidate;
		const range = candidate.range;
		const key = [
			candidate.origin,
			candidate.path,
			range?.startLine ?? "",
			range?.endLine ?? "",
			range?.startByte ?? "",
			range?.endByte ?? "",
			candidate.symbol ?? "",
			candidate.qualifiedSymbol ?? "",
			candidate.signature ?? "",
			candidate.relation ?? "",
			candidate.hop ?? 0,
			candidate.contentHash ?? "",
			candidate.contentVersion ?? "",
		].join("\0");
		if (!result.has(key)) result.set(key, value);
	}
	return [...result.values()];
}

function normalizeHash(value: string): string {
	return value.replace(/^sha256:/u, "").toLocaleLowerCase();
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function aborted(path?: string): ReturnType<typeof fail> {
	return fail("OPERATION_ABORTED", "grep was aborted.", path === undefined ? {} : { path });
}

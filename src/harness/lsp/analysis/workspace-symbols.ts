import type { WorkspaceSymbol } from "vscode-languageserver-protocol";

import type { CodeAnalysisStatus } from "../../code-index/types.ts";
import { LspClient } from "../client/client.ts";
import { combinedStatus, type AnalysisRequests } from "./requests.ts";
import {
	normalizeSymbolText,
	qualifiedSymbolName,
	workspaceSymbolLocation,
	workspaceSymbolSeed,
	type WorkspaceSymbolSeed,
} from "./symbols.ts";
import type { LspConfig } from "../types.ts";
import { fileUriToPath, workspaceRelativePath } from "../protocol/uri.ts";

const RESOLVE_CONCURRENCY = 4;

export interface WorkspaceSymbolSeedsInput {
	readonly root: string;
	readonly query: string;
	readonly owners: ReadonlyMap<string, string>;
}

export interface ResolvedWorkspaceSymbol {
	readonly client: LspClient;
	readonly seed: WorkspaceSymbolSeed;
}

export interface WorkspaceSymbolSeeds {
	readonly seeds: readonly ResolvedWorkspaceSymbol[];
	readonly coverage: ReadonlyMap<string, CodeAnalysisStatus>;
}

type SymbolCandidate =
	| { kind: "complete"; client: LspClient; seed: WorkspaceSymbolSeed }
	| { kind: "resolve"; client: LspClient; path: string; symbol: WorkspaceSymbol };

/** 各服务器和 resolve 请求独立返回结果，共用候选预算和稳定选择顺序。 */
export async function resolveWorkspaceSymbolSeeds(
	input: WorkspaceSymbolSeedsInput,
	config: LspConfig["grep"],
	requests: AnalysisRequests,
	clients: readonly LspClient[],
): Promise<WorkspaceSymbolSeeds> {
	const serverResults = await Promise.all(clients.map(async (client) => ({
		client,
		result: await requests.run(client.capabilities()?.workspaceSymbolProvider,
			(options) => client.workspaceSymbols(input.query, options)),
	})));
	const coverage = new Map<string, CodeAnalysisStatus>();
	const candidates: SymbolCandidate[] = [];
	const seenRaw = new Set<string>();
	for (const { client, result } of serverResults) {
		for (const [path, owner] of input.owners) {
			if (owner === client.server.id) coverage.set(path, result.status);
		}
		if (result.status !== "ok") continue;
		for (const symbol of result.value) {
			if (requests.signal?.aborted === true) break;
			const location = workspaceSymbolLocation(symbol);
			if (location !== undefined) {
				const seed = workspaceSymbolSeed(input.root, input.query, symbol);
				if (seed === undefined || input.owners.get(seed.path) !== client.server.id) continue;
				const key = symbolHitKey(seed);
				if (seenRaw.has(key)) continue;
				seenRaw.add(key);
				candidates.push({ kind: "complete", client, seed });
				continue;
			}
			const relative = relativePathForUri(input.root, symbol.location.uri);
			if (relative === undefined || input.owners.get(relative) !== client.server.id) continue;
			candidates.push({ kind: "resolve", client, path: relative, symbol });
		}
	}

	candidates.sort((left, right) => symbolCandidatePriority(input.query, left) - symbolCandidatePriority(input.query, right));
	const accepted: ResolvedWorkspaceSymbol[] = [];
	const seenHits = new Set<string>();
	let exactLeafCount = 0;
	let candidateIndex = 0;
	while (
		accepted.length < config.max_symbols
		&& candidateIndex < candidates.length
		&& requests.signal?.aborted !== true
	) {
		const remaining = config.max_symbols - accepted.length;
		const batchSize = Math.min(RESOLVE_CONCURRENCY, remaining, candidates.length - candidateIndex);
		const batch = candidates.slice(candidateIndex, candidateIndex + batchSize);
		candidateIndex += batchSize;
		const resolved = await Promise.all(batch.map(async (candidate) => {
			if (candidate.kind === "complete") return { client: candidate.client, seed: candidate.seed };
			const provider = candidate.client.capabilities()?.workspaceSymbolProvider;
			const result = await requests.run(typeof provider === "object" && provider.resolveProvider === true,
				(options) => candidate.client.resolveWorkspaceSymbol(candidate.symbol, options));
			if (result.status !== "ok") {
				coverage.set(candidate.path, combinedStatus([coverage.get(candidate.path) ?? "ok", result.status]));
				return undefined;
			}
			const seed = workspaceSymbolSeed(input.root, input.query, result.value);
			if (seed === undefined || input.owners.get(seed.path) !== candidate.client.server.id) {
				coverage.set(candidate.path, combinedStatus([coverage.get(candidate.path) ?? "ok", "unavailable"]));
				return undefined;
			}
			return { client: candidate.client, seed };
		}));
		for (const result of resolved) {
			if (result === undefined) continue;
			const exactLeaf = isExactLeafQuery(input.query, result.seed);
			if (exactLeaf && exactLeafCount >= config.max_exact_leaf_symbols) {
				markSkipped(result.seed.path);
				continue;
			}
			const key = symbolHitKey(result.seed);
			if (seenHits.has(key)) continue;
			seenHits.add(key);
			accepted.push(result);
			if (exactLeaf) exactLeafCount += 1;
			if (accepted.length >= config.max_symbols) break;
		}
	}
	for (const candidate of candidates.slice(candidateIndex)) {
		markSkipped(candidate.kind === "complete" ? candidate.seed.path : candidate.path);
	}
	return { seeds: accepted, coverage };

	function markSkipped(path: string): void {
		if (coverage.get(path) === "ok") coverage.set(path, "skipped");
	}
}

function relativePathForUri(root: string, uri: string): string | undefined {
	const filePath = fileUriToPath(uri);
	return filePath === undefined ? undefined : workspaceRelativePath(root, filePath);
}

function symbolCandidatePriority(query: string, candidate: SymbolCandidate): number {
	const name = candidate.kind === "complete" ? symbolLeaf(candidate.seed.symbol) : symbolLeaf(candidate.symbol.name);
	const qualifiedName = candidate.kind === "complete" ? candidate.seed.qualified_symbol : qualifiedSymbolName(candidate.symbol);
	const qualified = qualifiedName === undefined ? undefined : normalizeSymbolText(qualifiedName);
	const target = normalizeSymbolText(query);
	if (qualified === target) return 0;
	if (name === target) return 1;
	if (name.startsWith(target)) return 2;
	return 3;
}

function isExactLeafQuery(query: string, seed: WorkspaceSymbolSeed): boolean {
	return !/[.:#]/u.test(query) && symbolLeaf(seed.symbol) === normalizeSymbolText(query);
}

function symbolLeaf(value: string): string {
	const normalized = normalizeSymbolText(value);
	return normalized.slice(normalized.lastIndexOf(".") + 1);
}

function symbolHitKey(hit: WorkspaceSymbolSeed): string {
	return [hit.path, hit.range.start.line, hit.range.end.line, hit.symbol].join("\0");
}

import type { SymbolInformation, WorkspaceSymbol } from "vscode-languageserver-protocol";

import { LspClient } from "../client/client.js";
import type { OperationDeadline } from "./deadline.js";
import {
	hasUriOnlyWorkspaceSymbolLocation,
	normalizeSymbolText,
	qualifiedSymbolName,
	workspaceSymbolLocation,
	workspaceSymbolSeed,
	type WorkspaceSymbolSeed,
} from "./symbols.js";
import type { LspConfig } from "../types.js";
import { fileUriToPath, workspaceRelativePath } from "../protocol/uri.js";

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

type WorkspaceSymbolServerResult = {
	readonly client: LspClient;
	readonly symbols: Array<SymbolInformation | WorkspaceSymbol>;
};

type SymbolCandidate =
	| { kind: "complete"; client: LspClient; seed: WorkspaceSymbolSeed }
	| { kind: "resolve"; client: LspClient; symbol: WorkspaceSymbol };

/** 查询、过滤和 resolve workspace symbols，返回后续 code analysis 使用的 seed。 */
export async function resolveWorkspaceSymbolSeeds(
	input: WorkspaceSymbolSeedsInput,
	config: LspConfig["grep"],
	operation: OperationDeadline,
	clients: readonly LspClient[],
): Promise<ResolvedWorkspaceSymbol[] | undefined> {
	const serverResults = await Promise.all(clients.map(async (client) => {
		if (operation.signal.aborted) return undefined;
		const symbols = await client.workspaceSymbols(input.query, operation.requestOptions());
		return symbols === undefined ? undefined : { client, symbols };
	}));
	const completeServerResults = serverResults.filter(
		(result): result is WorkspaceSymbolServerResult => result !== undefined,
	);
	if (operation.signal.aborted || completeServerResults.length !== serverResults.length) return undefined;

	const candidates: SymbolCandidate[] = [];
	const seenRaw = new Set<string>();
	for (const result of completeServerResults) {
		for (const symbol of result.symbols) {
			if (operation.signal.aborted) return undefined;
			const location = workspaceSymbolLocation(symbol);
			if (location !== undefined) {
				const seed = workspaceSymbolSeed(input.root, input.query, symbol);
				if (seed === undefined || input.owners.get(seed.path) !== result.client.server.id) continue;
				const key = symbolHitKey(seed);
				if (seenRaw.has(key)) continue;
				seenRaw.add(key);
				candidates.push({ kind: "complete", client: result.client, seed });
				continue;
			}
			if (!hasUriOnlyWorkspaceSymbolLocation(symbol) || typeof symbol.name !== "string" || typeof symbol.kind !== "number") continue;
			const relative = relativePathForUri(input.root, symbol.location.uri);
			if (relative === undefined || input.owners.get(relative) !== result.client.server.id) continue;
			candidates.push({ kind: "resolve", client: result.client, symbol });
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
		&& !operation.signal.aborted
	) {
		const remaining = config.max_symbols - accepted.length;
		const batchSize = Math.min(RESOLVE_CONCURRENCY, remaining, candidates.length - candidateIndex);
		const batch = candidates.slice(candidateIndex, candidateIndex + batchSize);
		candidateIndex += batchSize;
		const resolved = await Promise.all(batch.map(async (candidate) => {
			if (candidate.kind === "complete") return { client: candidate.client, seed: candidate.seed };
			if (operation.signal.aborted) return undefined;
			const symbol = await candidate.client.resolveWorkspaceSymbol(candidate.symbol, operation.requestOptions());
			if (symbol === undefined || operation.signal.aborted) return undefined;
			const seed = workspaceSymbolSeed(input.root, input.query, symbol);
			return seed === undefined || input.owners.get(seed.path) !== candidate.client.server.id
				? undefined
				: { client: candidate.client, seed };
		}));
		const completeResolved = resolved.filter(
			(result): result is ResolvedWorkspaceSymbol => result !== undefined,
		);
		if (operation.signal.aborted || completeResolved.length !== resolved.length) return undefined;
		for (const result of completeResolved) {
			const exactLeaf = isExactLeafQuery(input.query, result.seed);
			if (exactLeaf && exactLeafCount >= config.max_exact_leaf_symbols) continue;
			const key = symbolHitKey(result.seed);
			if (seenHits.has(key)) continue;
			seenHits.add(key);
			accepted.push(result);
			if (exactLeaf) exactLeafCount += 1;
			if (accepted.length >= config.max_symbols) break;
		}
	}
	return operation.signal.aborted ? undefined : accepted;
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

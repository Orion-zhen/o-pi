import pLimit from "p-limit";
import type { SymbolInformation, WorkspaceSymbol } from "vscode-languageserver-protocol";

import { LspClient } from "../client/client.js";
import { waitUnlessAborted, type OperationDeadline } from "./deadline.js";
import {
	hasUriOnlyWorkspaceSymbolLocation,
	workspaceSymbolLocation,
	workspaceSymbolSeed,
	type WorkspaceSymbolSeed,
} from "./symbols.js";
import type { LoadedLspConfig, LspServerConfig } from "../types.js";
import { fileUriToPath, workspaceRelativePath } from "../protocol/uri.js";

const RESOLVE_CONCURRENCY = 4;

export interface WorkspaceSymbolContext {
	clientForServer(root: string, server: LspServerConfig): Promise<LspClient | undefined>;
	serverOwnsPath(root: string, server: LspServerConfig, relativePath: string): boolean;
}

export interface WorkspaceSymbolSeedsInput {
	readonly root: string;
	readonly query: string;
	readonly allowedPaths: ReadonlySet<string>;
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
	config: LoadedLspConfig,
	operation: OperationDeadline,
	servers: readonly LspServerConfig[],
	context: WorkspaceSymbolContext,
): Promise<ResolvedWorkspaceSymbol[] | undefined> {
	const serverResults = await Promise.all(servers.map(async (server) => {
		if (operation.signal.aborted) return undefined;
		const client = await waitUnlessAborted(context.clientForServer(input.root, server), operation.signal);
		if (client === undefined || operation.signal.aborted) return undefined;
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
				if (seed === undefined || !input.allowedPaths.has(seed.path) || !context.serverOwnsPath(input.root, result.client.server, seed.path)) continue;
				const key = symbolHitKey(seed);
				if (seenRaw.has(key)) continue;
				seenRaw.add(key);
				candidates.push({ kind: "complete", client: result.client, seed });
				continue;
			}
			if (!hasUriOnlyWorkspaceSymbolLocation(symbol) || typeof symbol.name !== "string" || typeof symbol.kind !== "number") continue;
			const relative = relativePathForUri(input.root, symbol.location.uri);
			if (relative === undefined || !input.allowedPaths.has(relative) || !context.serverOwnsPath(input.root, result.client.server, relative)) continue;
			const key = unresolvedSymbolKey(symbol);
			if (seenRaw.has(key)) continue;
			seenRaw.add(key);
			candidates.push({ kind: "resolve", client: result.client, symbol });
		}
	}

	candidates.sort((left, right) => symbolCandidatePriority(input.query, left) - symbolCandidatePriority(input.query, right));
	const accepted: ResolvedWorkspaceSymbol[] = [];
	const seenHits = new Set<string>();
	const resolveLimit = pLimit(RESOLVE_CONCURRENCY);
	let exactLeafCount = 0;
	let candidateIndex = 0;
	while (
		accepted.length < config.config.grep.max_symbols
		&& candidateIndex < candidates.length
		&& !operation.signal.aborted
	) {
		const remaining = config.config.grep.max_symbols - accepted.length;
		const batchSize = Math.min(RESOLVE_CONCURRENCY, remaining, candidates.length - candidateIndex);
		const batch = candidates.slice(candidateIndex, candidateIndex + batchSize);
		candidateIndex += batchSize;
		const resolved = await Promise.all(batch.map((candidate) => {
			if (candidate.kind === "complete") return Promise.resolve({ client: candidate.client, seed: candidate.seed });
			return resolveLimit(async () => {
				if (operation.signal.aborted) return undefined;
				const symbol = await candidate.client.resolveWorkspaceSymbol(candidate.symbol, operation.requestOptions());
				if (symbol === undefined || operation.signal.aborted) return undefined;
				const seed = workspaceSymbolSeed(input.root, input.query, symbol);
				return seed === undefined || !input.allowedPaths.has(seed.path) || !context.serverOwnsPath(input.root, candidate.client.server, seed.path)
					? undefined
					: { client: candidate.client, seed };
			});
		}));
		const completeResolved = resolved.filter(
			(result): result is ResolvedWorkspaceSymbol => result !== undefined,
		);
		if (operation.signal.aborted || completeResolved.length !== resolved.length) return undefined;
		for (const result of completeResolved) {
			const exactLeaf = isExactLeafQuery(input.query, result.seed);
			if (exactLeaf && exactLeafCount >= config.config.grep.max_exact_leaf_symbols) continue;
			const key = symbolHitKey(result.seed);
			if (seenHits.has(key)) continue;
			seenHits.add(key);
			accepted.push(result);
			if (exactLeaf) exactLeafCount += 1;
			if (accepted.length >= config.config.grep.max_symbols) break;
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
	const qualified = candidate.kind === "complete"
		? candidate.seed.qualified_symbol === undefined
			? /[.:#]/u.test(candidate.seed.symbol) ? normalizeSymbolText(candidate.seed.symbol) : undefined
			: normalizeSymbolText(candidate.seed.qualified_symbol)
		: "containerName" in candidate.symbol && typeof candidate.symbol.containerName === "string" && candidate.symbol.containerName.length > 0
			? /[.:#]/u.test(candidate.symbol.name)
				? normalizeSymbolText(candidate.symbol.name)
				: normalizeSymbolText(`${candidate.symbol.containerName}.${candidate.symbol.name}`)
			: /[.:#]/u.test(candidate.symbol.name) ? normalizeSymbolText(candidate.symbol.name) : undefined;
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

function normalizeSymbolText(value: string): string {
	return value.replace(/::|#/gu, ".").toLocaleLowerCase();
}

function unresolvedSymbolKey(symbol: WorkspaceSymbol): string {
	return [symbol.location.uri, symbol.name, symbol.kind, symbol.containerName ?? "", shallowDataKey(symbol.data)].join("\0");
}

function shallowDataKey(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `array:${value.length}:${value.slice(0, 4).map(shallowPrimitiveKey).join(",")}`;
	if (typeof value !== "object") return typeof value;
	return Object.entries(value)
		.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
		.slice(0, 8)
		.map(([key, item]) => `${key}=${shallowPrimitiveKey(item)}`)
		.join(",");
}

function shallowPrimitiveKey(value: unknown): string {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? String(value)
		: typeof value;
}

function symbolHitKey(hit: WorkspaceSymbolSeed): string {
	return [hit.path, hit.start_line, hit.end_line, hit.symbol].join("\0");
}

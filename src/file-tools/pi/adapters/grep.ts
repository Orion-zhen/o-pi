import type { RepoMapQueryCandidate } from "../../../repo-map/query.js";
import { GrepTool, formatCompactGrepResult } from "../../grep/command.js";
import type { GrepGraphCandidate, GrepGraphSource, GrepSymbolSource } from "../../grep/ports.js";
import type { GrepParams } from "../../grep/types.js";
import type { FileToolsHost, FileToolsInvocation } from "../../runtime/host.js";
import { isFailed } from "../../shared/result.js";
import type { FileToolLspHooks } from "../../types.js";
import { formatErrorModelResult } from "../model-output.js";
import type { LazyRepoMap } from "../lazy-repo-map.js";

export interface ExecuteGrepOptions {
	readonly cwd: string;
	readonly sessionId: string;
	readonly signal?: AbortSignal;
	readonly host: FileToolsHost;
	readonly lsp: FileToolLspHooks;
	readonly repoMap: LazyRepoMap;
}

let tool: GrepTool | undefined;

export async function executeGrep(params: GrepParams, options: ExecuteGrepOptions) {
	const opened = await options.host.open({
		cwd: options.cwd,
		sessionId: options.sessionId,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	if (isFailed(opened)) return failedResult(opened);
	try {
		tool ??= new GrepTool();
		const result = await tool.execute(params, {
			filesystem: opened.filesystem,
			operation: opened.context,
			limits: opened.limits,
			symbols: createGrepSymbolSource(options.lsp, opened),
			graph: createGrepGraphSource(options.repoMap, opened),
		});
		if (isFailed(result)) return failedResult(result);
		return { content: [{ type: "text" as const, text: formatCompactGrepResult(result) }], details: result };
	} finally { opened.dispose(); }
}

/** Disposes only grep-owned indexes, pending builds, workers, and parsers. */
export function dispose(): void {
	tool?.dispose();
	tool = undefined;
}

export function createGrepSymbolSource(lsp: FileToolLspHooks, invocation: FileToolsInvocation): GrepSymbolSource {
	return {
		async query(input) {
			if (input.signal?.aborted === true || lsp.grepSymbols === undefined) return [];
			const workspace = invocation.nativeBridge.getNativeIdentity(invocation.filesystem.root);
			if (workspace === undefined) return [];
			const candidates = await lsp.grepSymbols({
				workspaceRoot: workspace.nativePath,
				query: input.query,
				path: input.root.displayPath,
				allowedPaths: new Set(input.allowedPaths),
				...(input.signal === undefined ? {} : { signal: input.signal }),
			});
			return candidates.map((candidate) => ({
				path: candidate.path,
				startLine: candidate.start_line,
				endLine: candidate.end_line,
				kind: candidate.kind,
				symbol: candidate.symbol,
				...(candidate.signature === undefined ? {} : { signature: candidate.signature }),
				reason: candidate.reason,
				...(candidate.origin === undefined ? {} : { origin: candidate.origin }),
			}));
		},
	};
}

export function createGrepGraphSource(repoMap: LazyRepoMap, invocation: FileToolsInvocation): GrepGraphSource {
	return {
		async query(input) {
			if (input.signal?.aborted === true) return undefined;
			const identity = invocation.nativeBridge.getNativeIdentity(input.root);
			if (identity === undefined) return undefined;
			const result = await repoMap.query.query({ requestedPath: identity.nativePath, query: input.query, limit: input.limit });
			if (result === undefined || isAborted(input.signal)) return undefined;
			const root = await invocation.filesystem.paths.resolveExisting(
				result.root,
				{ expected: "directory", followFinalSymlink: true },
				invocation.context,
			);
			if (!root.ok || root.value.kind !== "directory") return undefined;
			return { root: root.value, candidates: result.candidates.map(toGraphCandidate) };
		},
	};
}

function toGraphCandidate(candidate: RepoMapQueryCandidate): GrepGraphCandidate {
	return {
		path: candidate.path,
		...(candidate.contentHash === undefined ? {} : { contentHash: candidate.contentHash }),
		...(candidate.symbol === undefined ? {} : {
			symbol: {
				id: candidate.symbol.id,
				kind: candidate.symbol.kind,
				...(candidate.symbol.name === undefined ? {} : { name: candidate.symbol.name }),
				...(candidate.symbol.qualifiedName === undefined ? {} : { qualifiedName: candidate.symbol.qualifiedName }),
				...(candidate.symbol.signature === undefined ? {} : { signature: candidate.symbol.signature }),
				range: { ...candidate.symbol.range },
			},
		}),
		...(candidate.range === undefined ? {} : { range: { ...candidate.range } }),
		confidence: candidate.confidence,
		hop: candidate.hop,
		reasons: [...candidate.reasons],
		matchedAliases: candidate.matchedAliases.map(({ term, canonical }) => ({ term, canonical })),
		relatedEdges: candidate.relatedEdges.map(({ hop, confidence, resolution, relatedFiles }) => ({
			hop,
			confidence,
			resolution,
			relatedFiles: relatedFiles.map(({ path, contentHash }) => ({ path, ...(contentHash === undefined ? {} : { contentHash }) })),
		})),
	};
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function failedResult(result: Parameters<typeof formatErrorModelResult>[0]) {
	return { content: [{ type: "text" as const, text: formatErrorModelResult(result) }], details: result };
}

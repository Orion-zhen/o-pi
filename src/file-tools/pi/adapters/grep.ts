import type { RepoMapQueryCandidate } from "../../../repo-map/query/query.js";
import { GrepTool, formatCompactGrepResult } from "../../grep/command.js";
import type { GrepHintSource, GrepPositionHint } from "../../grep/ports.js";
import type { GrepParams } from "../../grep/types.js";
import type { FileToolsHost, FileToolsInvocation } from "../../runtime/host.js";
import { isFailed } from "../../shared/result.js";
import type { LspFileOperations } from "../../../lsp/file-hooks.js";
import { formatErrorModelResult } from "../model-output.js";
import type { RepoMapToolPorts } from "../lazy-repo-map.js";

export interface ExecuteGrepOptions {
	readonly cwd: string;
	readonly sessionId: string;
	readonly signal?: AbortSignal;
	readonly host: FileToolsHost;
	readonly lsp: LspFileOperations;
	readonly repoMap: RepoMapToolPorts;
}

export function createGrepAdapter() {
	const tool = new GrepTool();
	return {
		async execute(params: GrepParams, options: ExecuteGrepOptions) {
			const opened = await options.host.open({
				cwd: options.cwd,
				sessionId: options.sessionId,
				...(options.signal === undefined ? {} : { signal: options.signal }),
			});
			if (isFailed(opened)) return failedResult(opened);
			try {
				const result = await tool.execute(params, {
					filesystem: opened.filesystem,
					operation: opened.context,
					limits: opened.limits,
					lspHints: createLspGrepHintSource(options.lsp, opened),
					repoMapHints: createRepoMapGrepHintSource(options.repoMap, opened),
				});
				if (isFailed(result)) return failedResult(result);
				return { content: [{ type: "text" as const, text: formatCompactGrepResult(result) }], details: result };
			} finally {
				opened.dispose();
			}
		},
		dispose() {
			tool.dispose();
		},
	};
}

export function createLspGrepHintSource(lsp: LspFileOperations, invocation: FileToolsInvocation): GrepHintSource {
	return {
		async query(input) {
			if (input.signal?.aborted === true || lsp.symbols === undefined) return [];
			const workspace = invocation.nativeBridge.getNativeIdentity(invocation.filesystem.root);
			if (workspace === undefined) return [];
			const candidates = await lsp.symbols({
				workspaceRoot: workspace.nativePath,
				query: input.query,
				allowedPaths: new Set(input.allowedPaths),
				...(input.relationQuery === undefined ? {} : { relationQuery: input.relationQuery }),
				...(input.signal === undefined ? {} : { signal: input.signal }),
			});
			return candidates.map((candidate): GrepPositionHint => ({
				path: candidate.path,
				range: { startLine: candidate.start_line, endLine: candidate.end_line },
				origin: candidate.origin === "reference" ? "lsp-reference" : "lsp-symbol",
				confidence: candidate.exact ? 1 : candidate.origin === "reference" ? 0.9 : 0.8,
				relation: candidate.origin === "reference" ? "reference" : "definition",
				reasons: [candidate.origin === "reference"
					? "lsp reference"
					: candidate.exact ? "lsp exact symbol" : "lsp symbol"],
			}));
		},
	};
}

export function createRepoMapGrepHintSource(repoMap: RepoMapToolPorts, invocation: FileToolsInvocation): GrepHintSource {
	return {
		async query(input) {
			if (input.signal?.aborted === true) return [];
			const identity = invocation.nativeBridge.getNativeIdentity(input.root);
			if (identity === undefined) return [];
			const result = await repoMap.query.query({
				requestedPath: identity.nativePath,
				query: input.query,
				limit: input.limit,
				...(input.signal === undefined ? {} : { signal: input.signal }),
			});
			if (result === undefined || isAborted(input.signal)) return [];
			return result.candidates.flatMap(toGraphHint);
		},
	};
}

function toGraphHint(candidate: RepoMapQueryCandidate): GrepPositionHint[] {
	const symbol = candidate.symbol;
	const range = symbol?.range ?? candidate.range;
	if (candidate.hop === 2 || range === undefined) return [];
	const aliasReasons = candidate.matchedAliases
		.filter(({ term, canonical }) => term.toLocaleLowerCase() !== canonical.toLocaleLowerCase())
		.map(({ term, canonical }) => `alias ${term}->${canonical}`);
	const relation = relationFromReasons(candidate.reasons);
	return [{
		path: candidate.path,
		range: { ...range },
		origin: "repo-map",
		confidence: candidate.confidence,
		...(candidate.contentHash === undefined ? {} : { contentHash: candidate.contentHash }),
		...(relation === undefined ? {} : { relation }),
		hop: candidate.hop,
		reasons: [...candidate.reasons, ...aliasReasons],
	}];
}

function relationFromReasons(reasons: readonly string[]): string | undefined {
	return reasons.find((reason) => reason === "caller" || reason === "callee" || reason === "reference"
		|| reason === "test" || reason === "import" || reason === "registration" || reason === "entrypoint")
		?? (reasons.some((reason) => reason === "definition" || reason === "export" || reason === "public api") ? "definition" : undefined);
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function failedResult(result: Parameters<typeof formatErrorModelResult>[0]) {
	return { content: [{ type: "text" as const, text: formatErrorModelResult(result) }], details: result };
}

import { FindTool } from "../../find/command.js";
import type { FindGraphCandidate, FindGraphSource } from "../../find/graph-source.js";
import type { FindParams } from "../../find/types.js";
import type { FileToolsInvocation, FileToolsHost } from "../../runtime/host.js";
import { isFailed } from "../../shared/result.js";
import type { RepoMapQueryCandidate } from "../../../repo-map/query.js";
import type { RepoMapToolPorts } from "../lazy-repo-map.js";
import { formatErrorModelResult } from "../model-output.js";

export interface ExecuteFindOptions {
	readonly cwd: string;
	readonly sessionId: string;
	readonly signal?: AbortSignal;
	readonly host: FileToolsHost;
	readonly repoMap: RepoMapToolPorts;
}

export function createFindAdapter() {
	const tool = new FindTool();
	return {
		async execute(params: FindParams, options: ExecuteFindOptions) {
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
					graph: createFindGraphSource(options.repoMap, opened),
				});
				if (isFailed(result)) return failedResult(result);
				return { content: [{ type: "text" as const, text: result.content }], details: result.details };
			} finally {
				opened.dispose();
			}
		},
		dispose() {
			tool.dispose();
		},
	};
}

export function createFindGraphSource(repoMap: RepoMapToolPorts, invocation: FileToolsInvocation): FindGraphSource {
	return {
		async query(input) {
			if (isAborted(input.signal)) return undefined;
			const rootIdentity = invocation.nativeBridge.getNativeIdentity(input.root);
			if (rootIdentity === undefined) return undefined;
			const result = await repoMap.query.query({
				requestedPath: rootIdentity.nativePath,
				query: input.query,
				limit: input.limit,
			});
			if (result === undefined || isAborted(input.signal)) return undefined;
			const graphRoot = await invocation.filesystem.paths.resolveExisting(
				result.root,
				{ expected: "directory", followFinalSymlink: true },
				invocation.context,
			);
			if (!graphRoot.ok || graphRoot.value.kind !== "directory") return undefined;
			return { root: graphRoot.value, candidates: result.candidates.map(toFindGraphCandidate) };
		},
	};
}

function toFindGraphCandidate(candidate: RepoMapQueryCandidate): FindGraphCandidate {
	return {
		path: candidate.path,
		...(candidate.contentHash === undefined ? {} : { contentHash: candidate.contentHash }),
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

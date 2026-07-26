import type { ReadVersionCache } from "../../core/read-cache.js";
import type { ReadObservationStore } from "../../read/command.js";
import type {
	MissingPathSource,
	ReadGraphContextSource,
	ReadStructureSource,
} from "../../read/ports.js";
import type { FileToolsInvocation } from "../../runtime/host.js";
import type { FileToolLspHooks } from "../../types.js";
import type { LazyRepoMap } from "../lazy-repo-map.js";

/** Transitional composition sink: host observation is authoritative; legacy edit still receives the same version. */
export function createReadObservationStore(
	invocation: FileToolsInvocation,
	legacy: ReadVersionCache | undefined,
): ReadObservationStore {
	return {
		remember(file, version) {
			const remembered = invocation.observation.remember(file, version);
			const identity = invocation.nativeBridge.getNativeIdentity(file);
			if (identity !== undefined) legacy?.remember(identity.canonicalPath, version.hash);
			return remembered;
		},
	};
}

export function createMissingPathSource(invocation: FileToolsInvocation, repoMap: LazyRepoMap): MissingPathSource {
	return {
		async suggest(input) {
			const root = invocation.nativeBridge.getNativeIdentity(input.root);
			if (root === undefined) return [];
			const result = await repoMap.query.query({ requestedPath: root.canonicalPath, query: input.query, limit: input.limit });
			return result?.candidates
				.filter((candidate) => candidate.hop === 0)
				.slice(0, input.limit)
				.map((candidate) => candidate.path) ?? [];
		},
	};
}

export function createReadStructureSource(
	invocation: FileToolsInvocation,
	lsp: FileToolLspHooks,
): ReadStructureSource {
	return {
		async context(input) {
			const root = invocation.nativeBridge.getNativeIdentity(invocation.filesystem.root);
			const file = invocation.nativeBridge.getNativeIdentity(input.file);
			if (root === undefined || file === undefined) return undefined;
			return await lsp.enhanceRead?.({
				workspaceRoot: root.canonicalPath,
				absolutePath: file.canonicalPath,
				relativePath: input.file.displayPath,
				content: input.content,
				start_line: input.startLine,
				end_line: input.endLine,
				truncated: input.truncated,
				partial: input.partial,
			});
		},
	};
}

export function createReadGraphContextSource(
	invocation: FileToolsInvocation,
	repoMap: LazyRepoMap,
): ReadGraphContextSource {
	return {
		async context(input) {
			const file = invocation.nativeBridge.getNativeIdentity(input.file);
			if (file === undefined) return undefined;
			const context = await repoMap.query.readContext({
				requestedPath: file.canonicalPath,
				contentHash: input.version.hash.replace(/^sha256:/u, ""),
				startLine: input.startLine,
				endLine: input.endLine,
				partial: input.partial,
				truncated: input.truncated,
			});
			if (context === undefined) return undefined;
			const rendered = await repoMap.formatReadContext(context);
			return rendered === undefined ? undefined : { context, rendered };
		},
	};
}

import type { ReadObservationStore } from "../../read/command.js";
import type {
	MissingPathSource,
	ReadGraphContextSource,
	ReadStructureSource,
} from "../../read/ports.js";
import type { FileToolsInvocation } from "../../runtime/host.js";
import type { LspFileOperations } from "../../../lsp/file-hooks.js";
import type { RepoMapToolPorts } from "../lazy-repo-map.js";

export function createReadObservationStore(invocation: FileToolsInvocation): ReadObservationStore {
	return invocation.observation;
}

export function createMissingPathSource(invocation: FileToolsInvocation, repoMap: RepoMapToolPorts): MissingPathSource {
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
	lsp: LspFileOperations,
): ReadStructureSource {
	return {
		async context(input) {
			const root = invocation.nativeBridge.getNativeIdentity(invocation.filesystem.root);
			const file = invocation.nativeBridge.getNativeIdentity(input.file);
			if (root === undefined || file === undefined) return undefined;
			return await lsp.read?.({
				workspaceRoot: root.canonicalPath,
				filePath: file.canonicalPath,
				content: input.content,
				startLine: input.startLine,
				endLine: input.endLine,
				truncated: input.truncated,
				partial: input.partial,
			});
		},
	};
}

export function createReadGraphContextSource(
	invocation: FileToolsInvocation,
	repoMap: RepoMapToolPorts,
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

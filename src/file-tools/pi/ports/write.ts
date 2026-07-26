import type { FileToolsInvocation } from "../../runtime/host.js";
import type { WriteDiagnosticsSource, WriteMutationObserver } from "../../write/ports.js";
import type { LspFileOperations } from "../../../lsp/file-hooks.js";
import type { RepoMapToolPorts } from "../lazy-repo-map.js";

export interface WritePiPorts {
	readonly diagnostics: WriteDiagnosticsSource;
	readonly observer: WriteMutationObserver;
	impact(): string | undefined;
}

export function createWritePorts(invocation: FileToolsInvocation, lsp: LspFileOperations, repoMap: RepoMapToolPorts): WritePiPorts {
	let renderedImpact: string | undefined;
	return {
		diagnostics: {
			async afterWrite(input) {
				const root = invocation.nativeBridge.getNativeIdentity(invocation.filesystem.root);
				const target = invocation.nativeBridge.getNativeIdentity(input.target);
				if (root === undefined || target === undefined) return undefined;
				return await lsp.afterWrite?.({
					workspaceRoot: root.canonicalPath,
					filePath: target.canonicalPath,
					content: input.content,
				});
			},
		},
		observer: {
			async observe(input) {
				const target = invocation.nativeBridge.getNativeIdentity(input.target);
				if (target === undefined) return undefined;
				const update = await repoMap.query.syncMutation({
					requestedPath: target.canonicalPath,
					...(input.firstChangedLine === undefined ? {} : { changedLine: input.firstChangedLine }),
					...(input.signal === undefined ? {} : { signal: input.signal }),
				});
				renderedImpact = await repoMap.formatImpact(update?.impact);
				return update;
			},
		},
		impact: () => renderedImpact,
	};
}

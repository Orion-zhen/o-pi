import type { FileToolsInvocation } from "../../runtime/host.js";
import type { WriteDiagnosticsSource, WriteMutationObserver } from "../../write/ports.js";
import type { LspFileOperations } from "../../../lsp/file-hooks.js";
import type { RepoMapToolPorts } from "../lazy-repo-map.js";
import type { MutationPostProcessObserver } from "../progress.js";

export interface WritePiPorts {
	readonly diagnostics: WriteDiagnosticsSource;
	readonly observer: WriteMutationObserver;
	impact(): string | undefined;
}

export function createWritePorts(
	invocation: FileToolsInvocation,
	lsp: LspFileOperations,
	repoMap: RepoMapToolPorts,
	progress?: MutationPostProcessObserver,
): WritePiPorts {
	let renderedImpact: string | undefined;
	return {
		diagnostics: {
			async afterWrite(input) {
				safeNotify(() => progress?.lspStarted());
				const root = invocation.nativeBridge.getNativeIdentity(invocation.filesystem.root);
				const target = invocation.nativeBridge.getNativeIdentity(input.target);
				if (root === undefined || target === undefined || lsp.afterWrite === undefined) {
					safeNotify(() => progress?.lspCompleted(undefined));
					return undefined;
				}
				try {
					const diagnostics = await lsp.afterWrite({
						workspaceRoot: root.canonicalPath,
						filePath: target.canonicalPath,
						content: input.content,
						created: input.created,
					});
					safeNotify(() => progress?.lspCompleted(diagnostics));
					return diagnostics;
				} catch (error) {
					safeNotify(() => progress?.lspUnavailable());
					throw error;
				}
			},
		},
		observer: {
			async observe(input) {
				safeNotify(() => progress?.repoMapStarted());
				const target = invocation.nativeBridge.getNativeIdentity(input.target);
				if (target === undefined) {
					safeNotify(() => progress?.repoMapUnavailable());
					return undefined;
				}
				try {
					const update = await repoMap.query.syncMutation({
						requestedPath: target.canonicalPath,
						...(input.firstChangedLine === undefined ? {} : { changedLine: input.firstChangedLine }),
						...(input.signal === undefined ? {} : { signal: input.signal }),
					});
					renderedImpact = await repoMap.formatImpact(update?.impact);
					safeNotify(() => progress?.repoMapCompleted(update?.status));
					return update;
				} catch (error) {
					safeNotify(() => progress?.repoMapUnavailable());
					throw error;
				}
			},
		},
		impact: () => renderedImpact,
	};
}

function safeNotify(observer: () => void): void {
	try {
		observer();
	} catch {}
}

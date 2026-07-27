import type { EditDiagnosticsSource, EditMutationObserver } from "../../edit/ports.js";
import type { FileToolsInvocation } from "../../runtime/host.js";
import type { LspFileOperations } from "../../../lsp/file-hooks.js";
import type { RepoMapToolPorts } from "../lazy-repo-map.js";
import type { MutationBatchInvocation } from "../mutation-batch.js";
import type { MutationPostProcessObserver } from "../progress.js";

export interface EditPiPorts {
	readonly diagnostics: EditDiagnosticsSource;
	readonly observer: EditMutationObserver;
	impact(): string | undefined;
}

export function createEditPorts(
	invocation: FileToolsInvocation,
	lsp: LspFileOperations,
	repoMap: RepoMapToolPorts,
	progress?: MutationPostProcessObserver,
	batch?: MutationBatchInvocation,
): EditPiPorts {
	let renderedImpact: string | undefined;
	return {
		diagnostics: {
			async beforeEdit(input) {
				const root = invocation.nativeBridge.getNativeIdentity(invocation.filesystem.root);
				const target = invocation.nativeBridge.getNativeIdentity(input.target);
				if (root === undefined || target === undefined) return undefined;
				return await lsp.beforeEdit?.({
					workspaceRoot: root.canonicalPath,
					filePath: target.canonicalPath,
				});
			},
			async afterEdit(input) {
				const root = invocation.nativeBridge.getNativeIdentity(invocation.filesystem.root);
				const target = invocation.nativeBridge.getNativeIdentity(input.target);
				const lspInput = root === undefined || target === undefined ? undefined : {
					workspaceRoot: root.canonicalPath,
					filePath: target.canonicalPath,
					content: input.content,
					created: false,
					...(input.baseline === undefined ? {} : { baseline: input.baseline }),
				};
				if (batch !== undefined) return await batch.lsp(lspInput, lsp, progress);
				safeNotify(() => progress?.lspStarted());
				if (lspInput === undefined || lsp.afterWrite === undefined) {
					safeNotify(() => progress?.lspCompleted(undefined));
					return undefined;
				}
				try {
					const diagnostics = await lsp.afterWrite(lspInput);
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
				const target = invocation.nativeBridge.getNativeIdentity(input.target);
				const mutationInput = target === undefined ? undefined : {
					requestedPath: target.canonicalPath,
					...(input.firstChangedLine === undefined ? {} : { changedLine: input.firstChangedLine }),
					...(input.signal === undefined ? {} : { signal: input.signal }),
				};
				if (batch !== undefined) {
					const update = await batch.repoMap(mutationInput, repoMap, progress);
					renderedImpact = await repoMap.formatImpact(update?.impact);
					return update;
				}
				safeNotify(() => progress?.repoMapStarted());
				if (mutationInput === undefined) {
					safeNotify(() => progress?.repoMapUnavailable());
					return undefined;
				}
				try {
					const update = await repoMap.query.syncMutation(mutationInput);
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

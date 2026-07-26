import type { EditDiagnosticsSource, EditMutationObserver } from "../../edit/ports.js";
import type { FileToolsInvocation } from "../../runtime/host.js";
import type { FileToolLspHooks } from "../../types.js";
import type { LazyRepoMap } from "../lazy-repo-map.js";

export interface EditPiPorts {
	readonly diagnostics: EditDiagnosticsSource;
	readonly observer: EditMutationObserver;
	impact(): string | undefined;
}

export function createEditPorts(invocation: FileToolsInvocation, lsp: FileToolLspHooks, repoMap: LazyRepoMap): EditPiPorts {
	let renderedImpact: string | undefined;
	return {
		diagnostics: {
			async beforeEdit(input) {
				const root = invocation.nativeBridge.getNativeIdentity(invocation.filesystem.root);
				const target = invocation.nativeBridge.getNativeIdentity(input.target);
				if (root === undefined || target === undefined) return undefined;
				return await lsp.beforeEdit?.({
					workspaceRoot: root.canonicalPath,
					path: input.target.displayPath,
					absolutePath: target.canonicalPath,
				});
			},
			async afterEdit(input) {
				const root = invocation.nativeBridge.getNativeIdentity(invocation.filesystem.root);
				const target = invocation.nativeBridge.getNativeIdentity(input.target);
				if (root === undefined || target === undefined) return undefined;
				return await lsp.afterEdit?.({
					workspaceRoot: root.canonicalPath,
					path: input.target.displayPath,
					absolutePath: target.canonicalPath,
					content: input.content,
					...(input.baseline === undefined ? {} : { baseline: input.baseline }),
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

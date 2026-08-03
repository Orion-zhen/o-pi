import type { LspFileOperations } from "../../../lsp/file-hooks.js";
import type { MutationDiagnosticsSource } from "../../shared/mutation-diagnostics.js";
import type { FileToolsInvocation } from "../../runtime/host.js";
import type { MutationBatchInvocation } from "../mutation-batch.js";
import type { MutationPostProcessObserver } from "../progress.js";

export function createMutationDiagnosticsSource(
	invocation: FileToolsInvocation,
	lsp: LspFileOperations,
	progress?: MutationPostProcessObserver,
	batch?: MutationBatchInvocation,
): MutationDiagnosticsSource {
	return {
		async beforeMutation(input) {
			const root = invocation.nativeBridge.getNativeIdentity(invocation.filesystem.root);
			const target = invocation.nativeBridge.getNativeIdentity(input.target);
			if (root === undefined || target === undefined) return undefined;
			return await lsp.beforeMutation?.({
				workspaceRoot: root.canonicalPath,
				filePath: target.canonicalPath,
			});
		},
		async afterMutation(input) {
			const root = invocation.nativeBridge.getNativeIdentity(invocation.filesystem.root);
			const target = invocation.nativeBridge.getNativeIdentity(input.target);
			const lspInput = root === undefined || target === undefined ? undefined : {
				workspaceRoot: root.canonicalPath,
				filePath: target.canonicalPath,
				content: input.content,
				created: input.created,
				...(input.changedRanges === undefined ? {} : {
					changed_ranges: input.changedRanges.map((range) => ({
						start_line: range.startLine,
						end_line: range.endLine,
					})),
				}),
				...(input.baseline === undefined ? {} : { baseline: input.baseline }),
			};
			if (batch !== undefined) return await batch.lsp(lspInput, lsp, progress);
			safeNotify(() => progress?.lspStarted());
			if (lspInput === undefined || lsp.afterMutation === undefined) {
				safeNotify(() => progress?.lspCompleted(undefined));
				return undefined;
			}
			try {
				const diagnostics = await lsp.afterMutation(lspInput);
				safeNotify(() => progress?.lspCompleted(diagnostics));
				return diagnostics;
			} catch (error) {
				safeNotify(() => progress?.lspUnavailable());
				throw error;
			}
		},
	};
}

function safeNotify(observer: () => void): void {
	try {
		observer();
	} catch {}
}

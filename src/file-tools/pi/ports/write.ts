import type { FileToolsInvocation } from "../../runtime/host.js";
import type { WriteDiagnosticsSource } from "../../write/ports.js";
import type { LspFileOperations } from "../../../lsp/file-hooks.js";
import type { MutationBatchInvocation } from "../mutation-batch.js";
import type { MutationPostProcessObserver } from "../progress.js";

export interface WritePiPorts {
	readonly diagnostics: WriteDiagnosticsSource;
}

export function createWritePorts(
	invocation: FileToolsInvocation,
	lsp: LspFileOperations,
	progress?: MutationPostProcessObserver,
	batch?: MutationBatchInvocation,
): WritePiPorts {
	return {
		diagnostics: {
			async afterWrite(input) {
				const root = invocation.nativeBridge.getNativeIdentity(invocation.filesystem.root);
				const target = invocation.nativeBridge.getNativeIdentity(input.target);
				const lspInput = root === undefined || target === undefined ? undefined : {
					workspaceRoot: root.canonicalPath,
					filePath: target.canonicalPath,
					content: input.content,
					created: input.created,
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
	};
}

function safeNotify(observer: () => void): void {
	try {
		observer();
	} catch {}
}

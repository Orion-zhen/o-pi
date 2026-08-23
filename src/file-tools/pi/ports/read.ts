import type { ReadObservationStore } from "../../read/command.js";
import type { ReadStructureSource } from "../../read/ports.js";
import type { FileToolsInvocation } from "../../runtime/host.js";
import type { LspFileOperations } from "../../../lsp/index.js";

export function createReadObservationStore(invocation: FileToolsInvocation): ReadObservationStore {
	return invocation.observation;
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

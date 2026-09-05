import type { ReadStructureSource } from "../../read/ports.js";
import type { FileToolsInvocation } from "../../runtime/host.js";
import type { LspFileOperations } from "../../../lsp/index.js";

export function createReadStructureSource(
	invocation: FileToolsInvocation,
	lsp: LspFileOperations,
): ReadStructureSource {
	return {
		async context(input) {
			if (input.file.workspacePath === undefined) return undefined;
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

import { vi } from "vitest";
import { LspClient } from "../../../src/harness/lsp/client/client.ts";
import { LspDocumentSession } from "../../../src/harness/lsp/client/document-session.ts";
import { pathToFileUri } from "../../../src/harness/lsp/protocol/uri.ts";

/** 现有管理器单测替换协议边界，文档生命周期另由协议集成测试覆盖。 */
export function mockDocumentSessions(): void {
	vi.spyOn(LspClient.prototype, "withDocument").mockImplementation(async function<T>(
		this: LspClient, filePath: string, text: string, _signal: AbortSignal | undefined,
		operation: (session: LspDocumentSession) => Promise<T>,
	) {
		return operation(new LspDocumentSession(pathToFileUri(filePath), {
			capabilities: () => this.capabilities(), request: async () => undefined,
		}, (options) => this.documentSymbols(filePath, text, options)));
	});
	vi.spyOn(LspDocumentSession.prototype, "prepareCalls").mockImplementation(async function(this: LspDocumentSession, position) {
		const range = { start: position, end: { line: position.line, character: position.character + 6 } };
		return [{ name: "target", kind: 12, uri: this.uri, range, selectionRange: range }];
	});
	vi.spyOn(LspDocumentSession.prototype, "outgoingCalls").mockResolvedValue([]);
}

import { vi } from "vitest";
import type { ServerCapabilities } from "vscode-languageserver-protocol";
import type { LspClientDocumentContext } from "../../../src/harness/lsp/types.ts";
import { LspClient } from "../../../src/harness/lsp/client/client.ts";
import { LspDocumentSession } from "../../../src/harness/lsp/client/document-session.ts";

export function lspOk<T>(value: T) {
	return { status: "ok" as const, value };
}

/** 单测替换符号协议，连接和文档生命周期由集成测试覆盖。 */
export function mockDocumentSessions(fixedCapabilities?: ServerCapabilities): void {
	vi.spyOn(LspClient.prototype, "withDocument").mockImplementation(async function<T>(
		this: LspClient, document: LspClientDocumentContext, _signal: AbortSignal | undefined,
		operation: (session: LspDocumentSession) => Promise<T>,
	) {
		const run = (capabilities: ServerCapabilities) => operation(new LspDocumentSession(document.uri, {
			capabilities: () => capabilities, request: async () => ({ status: "unsupported" }),
		}, (options) => capabilities.documentSymbolProvider === undefined || capabilities.documentSymbolProvider === false
			? Promise.resolve({ status: "unsupported" }) : this.documentSymbols(document, options)));
		return fixedCapabilities === undefined
			? this.withSession(async (session) => run(session.connection.capabilities()))
			: run(fixedCapabilities);
	});
	vi.spyOn(LspDocumentSession.prototype, "prepareCalls").mockImplementation(async function(this: LspDocumentSession, position) {
		const range = { start: position, end: { line: position.line, character: position.character + 6 } };
		return lspOk([{ name: "target", kind: 12, uri: this.uri, range, selectionRange: range }]);
	});
	vi.spyOn(LspDocumentSession.prototype, "outgoingCalls").mockResolvedValue(lspOk([]));
}

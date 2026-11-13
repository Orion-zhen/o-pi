import type { CallHierarchyItem, Position } from "vscode-languageserver-protocol";
import { prepareCalls, requestDefinition, requestIncomingCalls, requestOutgoingCalls, requestReferences, type LspFeatureSession } from "../protocol/features.ts";
import { pathToFileUri } from "../protocol/uri.ts";
import type { LspClientDocumentContext, LspDocumentSymbols, LspRequestOptions, LspRequestResult } from "../types.ts";

export function lspDocument(filePath: string, text: string, languageId: string): LspClientDocumentContext {
	return { uri: pathToFileUri(filePath), path: filePath, text, languageId };
}

/** 查询绑定同一连接与文档队列，只在 withDocument 回调期间使用。 */
export class LspDocumentSession {
	constructor(
		readonly uri: string,
		private readonly connection: LspFeatureSession,
		readonly symbols: (options?: LspRequestOptions) => Promise<LspRequestResult<LspDocumentSymbols>>,
	) {}

	prepareCalls(position: Position, options?: LspRequestOptions) {
		return prepareCalls(this.connection, this.uri, position, options);
	}

	incomingCalls(item: CallHierarchyItem, options?: LspRequestOptions) {
		return requestIncomingCalls(this.connection, item, options);
	}

	outgoingCalls(item: CallHierarchyItem, options?: LspRequestOptions) {
		return requestOutgoingCalls(this.connection, item, options);
	}

	definition(position: Position, options?: LspRequestOptions) {
		return requestDefinition(this.connection, this.uri, position, options);
	}

	references(position: Position, options?: LspRequestOptions) {
		return requestReferences(this.connection, this.uri, position, options);
	}
}

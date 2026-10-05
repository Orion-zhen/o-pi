import type { CallHierarchyItem, Position } from "vscode-languageserver-protocol";
import { prepareCalls, requestDefinition, requestIncomingCalls, requestOutgoingCalls, requestReferences, type LspFeatureSession } from "../protocol/features.ts";
import type { LspDocumentSymbols, LspRequestOptions } from "../types.ts";

/** 查询绑定同一连接与文档队列，只在 withDocument 回调期间使用。 */
export class LspDocumentSession {
	constructor(
		readonly uri: string,
		private readonly connection: LspFeatureSession,
		readonly symbols: (options?: LspRequestOptions) => Promise<LspDocumentSymbols | undefined>,
	) {}

	capabilities() { return this.connection.capabilities(); }

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

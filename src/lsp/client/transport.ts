import type { MessageConnection, RequestType } from "vscode-jsonrpc/node";
import type { ServerCapabilities } from "vscode-languageserver-protocol";

import type { LspRequestOptions } from "../types.js";

/** client 内部各协作者共享的活动连接边界。 */
export interface LspClientTransport {
	capabilities(): ServerCapabilities | undefined;
	requestOnConnection<P, R, E>(
		connection: MessageConnection,
		type: RequestType<P, R, E>,
		params: P,
		options: LspRequestOptions,
	): Promise<R | undefined>;
	sendNotification(
		connection: MessageConnection,
		factory: (connection: MessageConnection) => Promise<void>,
	): Promise<boolean>;
	bumpIdleTimer(): void;
}

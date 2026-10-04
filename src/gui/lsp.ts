import type { LspStdioTransport, LspTcpTransport } from "../harness/lsp/types.ts";

export interface GuiLspServer {
	id: string;
	languages: string[];
	transport: (LspStdioTransport & { executable: string | null }) | LspTcpTransport;
}

export interface GuiLspServers {
	path: string;
	servers: GuiLspServer[];
}

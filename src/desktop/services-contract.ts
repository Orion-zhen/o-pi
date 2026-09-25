export type ServiceRequest =
	| { kind: "spawn"; args: string[]; cwd: string; env: NodeJS.ProcessEnv }
	| { kind: "proxy"; url: string }
	| { kind: "websocket"; url: string; options: SocketOptions };

export type ServiceReply =
	| { id: number; kind: "port" }
	| { id: number; kind: "proxy"; value: string }
	| { id: number; kind: "error"; message: string };

export type ProcessCommand = { kind: "kill"; signal: NodeJS.Signals };

export type ProcessEvent =
	| { kind: "stdout" | "stderr"; data: Uint8Array }
	| { kind: "exit"; code: number }
	| { kind: "error"; message: string };

export interface SocketOptions {
	protocols?: string[];
	headers?: Record<string, string>;
}

export type SocketCommand =
	| { kind: "send"; data: string | Uint8Array; bytes: number }
	| { kind: "close"; code?: number; reason?: string };

export type SocketEvent =
	| { kind: "open"; protocol: string; extensions: string }
	| { kind: "message"; data: string | ArrayBuffer }
	| { kind: "drain"; bytes: number }
	| { kind: "error"; message: string }
	| { kind: "close"; code: number; reason: string; wasClean: boolean };

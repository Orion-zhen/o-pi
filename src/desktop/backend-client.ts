import type { UtilityProcess } from "electron";
import type { DesktopDiagnostics } from "./diagnostics.ts";
import type { FileResource } from "../gui/host/workspace/file-resource.ts";
import type { BackendCall, BackendCommand, BackendControl, BackendMessage, BackendRequest } from "./backend-contract.ts";

export class BackendClient {
	private nextId = 0;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private shutdown: Promise<void> | undefined;
	private exited = false;
	private readonly exit = Promise.withResolvers<void>();
	get stopping(): boolean { return this.shutdown !== undefined; }

	constructor(private readonly child: UtilityProcess, private readonly diagnostics: DesktopDiagnostics) {
		child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
		child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
		child.on("message", (message: BackendMessage) => {
			switch (message.kind) {
				case "requestReceived": this.diagnostics.backend(String(message.id), message.at); return;
				case "userAvailable": this.diagnostics.user(message.sessionId, message.userTimestamp, message.at); return;
				case "result": this.pending.get(message.id)?.resolve(message.value); return;
				case "error": this.pending.get(message.id)?.reject(new Error(message.message)); return;
			}
		});
		child.once("exit", (code) => {
			this.exited = true;
			for (const task of this.pending.values()) task.reject(new Error(`SDK 后端已退出 (${code})`));
			this.pending.clear();
			this.exit.resolve();
		});
	}

	request(request: { kind: "resource"; token: string }): Promise<FileResource>;
	request(request: { kind: "activeSessions" }): Promise<number>;
	request(request: { kind: "action" | "query"; value: unknown }, submittedAt?: unknown): Promise<unknown>;
	async request(request: BackendCall, submittedAt?: unknown): Promise<unknown> {
		if (this.exited || this.stopping) throw new Error("SDK 后端不可用。");
		const id = this.nextId++;
		const traced = request.kind === "action" && this.diagnostics.request(String(id), request.value, submittedAt);
		let failed = true;
		try {
			const result = await new Promise<unknown>((resolve, reject) => {
				this.pending.set(id, { resolve, reject });
				this.child.postMessage({ ...request, id, traced } satisfies BackendRequest);
			});
			failed = false;
			return result;
		} finally {
			if (traced) this.diagnostics.result(String(id), failed);
			this.pending.delete(id);
		}
	}

	async activeSessions(): Promise<number> {
		if (this.exited) return 0;
		return this.request({ kind: "activeSessions" });
	}

	send(command: BackendControl): void {
		this.child.postMessage(command);
	}

	stop(): Promise<void> {
		if (this.exited) return this.exit.promise;
		if (!this.shutdown) {
			const timer = setTimeout(() => this.child.kill(), 10_000).unref();
			this.shutdown = this.exit.promise.finally(() => clearTimeout(timer));
			this.child.postMessage({ kind: "dispose" } satisfies BackendCommand);
		}
		return this.shutdown;
	}
}

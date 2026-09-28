import type { UtilityProcess } from "electron";
import type { DesktopDiagnostics } from "./diagnostics.ts";
import type { GuiDelivery } from "../gui/sync.ts";
import type { BackendCommand, BackendControl, BackendMessage, BackendRequest } from "./backend-contract.ts";

export class BackendClient {
	private nextId = 0;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; traced: boolean }>();
	private stopping = false;
	private exited = false;
	private timer: NodeJS.Timeout | undefined;

	constructor(
		private readonly child: UtilityProcess,
		onDelivery: (delivery: GuiDelivery, at: number) => void,
		onExit: (code: number, stopping: boolean) => void,
		private readonly diagnostics: DesktopDiagnostics,
	) {
		child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
		child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
		child.on("message", (message: BackendMessage) => {
			switch (message.kind) {
				case "delivery": onDelivery(message.value, message.at); return;
				case "requestReceived": this.diagnostics.backend(String(message.id), message.at); return;
				case "userAvailable": this.diagnostics.user(message.sessionId, message.userTimestamp, message.at); return;
				case "result": this.pending.get(message.id)?.resolve(message.value); return;
				case "error": this.pending.get(message.id)?.reject(new Error(message.message)); return;
				default: message satisfies never;
			}
		});
		child.once("exit", (code) => {
			this.exited = true;
			clearTimeout(this.timer);
			for (const [id, task] of this.pending) {
				if (task.traced) this.diagnostics.result(String(id), true);
				task.reject(new Error(`SDK 后端已退出 (${code})`));
			}
			this.pending.clear();
			onExit(code, this.stopping);
		});
	}

	async request(kind: BackendRequest["kind"], value: unknown, submittedAt: unknown): Promise<unknown> {
		if (this.exited || this.stopping) throw new Error("SDK 后端不可用。");
		const id = this.nextId++;
		const traced = kind === "action" && this.diagnostics.request(String(id), value, submittedAt);
		let failed = true;
		try {
			const result = await new Promise<unknown>((resolve, reject) => {
				this.pending.set(id, { resolve, reject, traced });
				this.child.postMessage({ kind, id, value, traced } satisfies BackendRequest);
			});
			failed = false;
			return result;
		} finally {
			if (traced && this.pending.has(id)) this.diagnostics.result(String(id), failed);
			this.pending.delete(id);
		}
	}

	send(command: BackendControl): void {
		this.child.postMessage(command);
	}

	/** 返回是否仍需等待后端退出。 */
	stop(): boolean {
		if (this.exited) return false;
		if (!this.stopping) {
			this.stopping = true;
			this.child.postMessage({ kind: "dispose" } satisfies BackendCommand);
			this.timer = setTimeout(() => this.child.kill(), 10_000).unref();
		}
		return true;
	}
}

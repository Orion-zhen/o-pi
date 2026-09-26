import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { GuiDelivery } from "../gui/sync.ts";

const MAX_BYTES = 2 * 1024 * 1024;
type Fields = Record<string, string | number | boolean | null>;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** 只记录身份与时间。写入串行且不阻塞请求，最多保留两份 2 MiB 日志。 */
export class DesktopDiagnostics {
	private readonly run = `${process.pid}-${Date.now()}`;
	private pending: Promise<void>;
	private size = 0;
	private failed = false;
	private closing: Promise<void> | undefined;
	private finished = false;
	get closed(): boolean { return this.finished; }
	private generation = 0;
	private deliveries = new Set<number>();

	constructor(private file: string) {
		this.pending = mkdir(path.dirname(file), { recursive: true }).then(async () => {
			try { this.size = (await stat(file)).size; }
			catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
		}).catch((error: unknown) => this.failure(error));
		this.write({ phase: "start" });
	}

	private failure(error: unknown): void {
		this.failed = true;
		console.error(`Desktop diagnostics unavailable: ${String(error)}`);
	}
	private write(fields: Fields): void {
		if (this.closing || this.failed) return;
		const line = JSON.stringify({ run: this.run, at: Date.now(), ...fields }) + "\n";
		const bytes = Buffer.byteLength(line);
		this.pending = this.pending.then(async () => {
			if (this.failed) return;
			if (this.size + bytes > MAX_BYTES) {
				await rename(this.file, `${this.file}.1`);
				this.size = 0;
			}
			await appendFile(this.file, line, { mode: 0o600 });
			this.size += bytes;
		}).catch((error: unknown) => this.failure(error));
	}

	request(id: string, value: unknown, submittedAt: unknown): boolean {
		if (!object(value) || !object(value.value)) return false;
		const action = value.value.action;
		if (typeof action !== "string" || !["prompt", "new", "workspace", "openSession", "sessions"].includes(action)) return false;
		this.write({ phase: "main_received", requestId: id, action,
			sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
			...(timestamp(submittedAt) ? { submittedAt } : {}),
		});
		return true;
	}
	backend(id: string, at: number): void { this.write({ phase: "backend_received", requestId: id, at }); }
	user(sessionId: string, userTimestamp: number, at: number): void { this.write({ phase: "user_available", sessionId, userTimestamp, at }); }
	result(id: string, failed: boolean): void { this.write({ phase: "request_settled", requestId: id, failed }); }

	reset(): void {
		this.deliveries.clear();
		this.generation++;
	}
	delivery(delivery: GuiDelivery, sentAt: unknown): boolean {
		let tracked = false;
		for (const event of delivery.events) {
			let fields: Fields;
			if (event.type === "selected") fields = { phase: "selection", sessionId: event.session?.id ?? null };
			else {
				const snapshot = event.type === "snapshot" ? event.value : undefined;
				const patch = event.type === "patch" ? event : undefined;
				const user = (snapshot?.messages ?? patch?.messages?.items)?.findLast((message) => message.role === "user");
				const sessionId = snapshot?.sessionId ?? patch?.sessionId;
				if (!user || user.role !== "user" || !sessionId) continue;
				fields = { phase: "user_snapshot", sessionId, userTimestamp: user.timestamp, full: event.type === "snapshot" };
			}
			this.write({ ...fields, generation: this.generation, deliveryId: delivery.id,
				...(timestamp(sentAt) ? { backendSentAt: sentAt } : {}),
			});
			tracked = true;
		}
		if (tracked) this.deliveries.add(delivery.id);
		return tracked;
	}
	received(id: number, at: number): void {
		if (this.deliveries.has(id)) this.write({ phase: "renderer_received", generation: this.generation, deliveryId: id, at });
	}
	acknowledge(id: number, appliedAt: unknown): void {
		for (const deliveryId of this.deliveries) {
			if (deliveryId > id) continue;
			this.write({ phase: "renderer_applied", generation: this.generation, deliveryId,
				...(timestamp(appliedAt) ? { appliedAt } : {}),
			});
			this.deliveries.delete(deliveryId);
		}
	}
	close(): Promise<void> {
		this.closing ??= this.pending.then(() => { this.finished = true; });
		return this.closing;
	}
}

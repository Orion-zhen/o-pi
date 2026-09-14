import type { CoordinatedPresenceConfig } from "./coordinator-protocol.ts";
import { createDiscordRpcTransport, type DiscordPresenceTransport } from "./transport.ts";
import type { DiscordActivityPayload, PresenceConnectionStatus } from "./types.ts";

interface PresenceTarget {
	config: CoordinatedPresenceConfig;
	activity: DiscordActivityPayload;
}

interface Connection {
	applicationId: string;
	transport: DiscordPresenceTransport;
	unsubscribe: () => void;
}

/** 将应用、内容和发送节奏作为一个目标管理，所有连接操作由同一任务串行执行。 */
export class DiscordCoordinatorOutput {
	private target: PresenceTarget | undefined;
	private connection: Connection | undefined;
	private lastSent: string | undefined;
	private lastAttemptAt = Number.NEGATIVE_INFINITY;
	private failed = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private working: Promise<void> | undefined;
	private closed = false;
	private reset = false;
	private generation = 0;
	private status: PresenceConnectionStatus = "disconnected";
	private readonly listeners = new Set<(status: PresenceConnectionStatus) => void>();

	show(target: PresenceTarget): void {
		if (this.closed) throw new Error("Discord presence output is disposed.");
		this.target = target;
		this.schedule();
	}

	async hide(): Promise<void> {
		this.target = undefined;
		this.generation += 1;
		this.reset = true;
		this.lastSent = undefined;
		this.failed = false;
		this.cancelTimer();
		await this.run();
	}

	async dispose(): Promise<void> {
		this.closed = true;
		await this.hide();
		this.setStatus("disabled");
		this.listeners.clear();
	}

	getStatus(): PresenceConnectionStatus {
		return this.status;
	}

	onStatus(listener: (status: PresenceConnectionStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private schedule(): void {
		this.cancelTimer();
		const target = this.target;
		if (this.working !== undefined || this.closed || target === undefined) return;
		if (targetKey(target) === this.lastSent && this.status === "connected") return;
		const interval = this.failed ? target.config.retryIntervalMs : target.config.updateIntervalMs;
		const delay = Math.max(0, this.lastAttemptAt + interval - Date.now());
		if (delay === 0) {
			void this.run();
		} else {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				void this.run();
			}, delay);
			this.timer.unref();
		}
	}

	private run(): Promise<void> {
		if (this.working !== undefined) return this.working;
		const task = Promise.resolve().then(() => this.sendLatest()).finally(async () => {
			// hide/dispose 可能发生在创建连接或发送期间，必须在同一任务结束前完成清理。
			while (this.reset) {
				this.reset = false;
				await this.disconnect();
			}
			this.working = undefined;
			this.schedule();
		});
		this.working = task;
		return task;
	}

	private async sendLatest(): Promise<void> {
		const target = this.target;
		const generation = this.generation;
		if (this.reset || this.connection?.applicationId !== target?.config.applicationId) {
			this.reset = false;
			await this.disconnect();
		}
		if (this.closed || target === undefined || target !== this.target || generation !== this.generation) return;
		this.lastAttemptAt = Date.now();
		try {
			if (this.connection === undefined) {
				this.setStatus("connecting");
				const transport = await createDiscordRpcTransport(target.config.applicationId);
				if (this.closed || generation !== this.generation || this.target?.config.applicationId !== target.config.applicationId) {
					await transport.close().catch(() => undefined);
					return;
				}
				const connection: Connection = {
					applicationId: target.config.applicationId,
					transport,
					unsubscribe: transport.onStatus((status) => {
						if (this.connection !== connection) return;
						if (status === "disconnected") {
							this.lastSent = undefined;
							this.failed = true;
						}
						this.setStatus(status);
						this.schedule();
					}),
				};
				this.connection = connection;
			}
			const latest = this.target;
			if (latest === undefined || latest.config.applicationId !== this.connection.applicationId) return;
			await this.connection.transport.setActivity(latest.activity);
			if (generation !== this.generation) return;
			this.lastSent = targetKey(latest);
			this.failed = false;
			this.setStatus(this.connection.transport.getStatus());
		} catch {
			if (generation !== this.generation) return;
			this.lastSent = undefined;
			this.failed = true;
			this.setStatus("disconnected");
		}
	}

	private async disconnect(): Promise<void> {
		const connection = this.connection;
		this.connection = undefined;
		this.lastSent = undefined;
		if (connection !== undefined) {
			connection.unsubscribe();
			await connection.transport.clearActivity().catch(() => undefined);
			await connection.transport.close().catch(() => undefined);
		}
		this.setStatus(this.closed ? "disabled" : "disconnected");
	}

	private cancelTimer(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private setStatus(status: PresenceConnectionStatus): void {
		if (this.status === status) return;
		this.status = status;
		for (const listener of this.listeners) listener(status);
	}
}

function targetKey(target: PresenceTarget): string {
	return JSON.stringify([target.config.applicationId, target.activity]);
}

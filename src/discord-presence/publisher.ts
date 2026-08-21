import type { DiscordPresenceTransport } from "./transport.js";
import type { DiscordActivityPayload } from "./types.js";

export interface PresenceClock {
	now(): number;
	schedule(delayMs: number, callback: () => void): () => void;
}

export function systemPresenceClock(): PresenceClock {
	return {
		now: Date.now,
		schedule(delayMs, callback) {
			const handle = setTimeout(callback, delayMs);
			handle.unref();
			return () => clearTimeout(handle);
		},
	};
}

/** 合并快速状态变化，并在 Discord 暂时不可用时保留最新 Presence 重试。 */
export class PresencePublisher {
	private pending: DiscordActivityPayload | undefined;
	private lastSent: string | undefined;
	private lastAttemptAt = Number.NEGATIVE_INFINITY;
	private cancelTimer: (() => void) | undefined;
	private sending = false;
	private stopped = false;
	private readonly unsubscribeStatus: () => void;

	constructor(
		private readonly transport: DiscordPresenceTransport,
		private readonly updateIntervalMs: number,
		private readonly retryIntervalMs: number,
		private readonly clock: PresenceClock = systemPresenceClock(),
	) {
		this.unsubscribeStatus = transport.onStatus((status) => {
			if (status !== "disconnected" || this.stopped) return;
			this.lastSent = undefined;
			if (this.pending !== undefined) this.schedule(this.retryIntervalMs);
		});
	}

	request(activity: DiscordActivityPayload): void {
		if (this.stopped) return;
		const serialized = serialize(activity);
		if (serialized === this.lastSent && this.transport.getStatus() === "connected") return;
		this.pending = activity;
		this.schedule(this.updateIntervalMs);
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		this.pending = undefined;
		this.unsubscribeStatus();
	}

	private schedule(minimumInterval: number): void {
		if (this.cancelTimer !== undefined || this.sending || this.stopped) return;
		const elapsed = this.clock.now() - this.lastAttemptAt;
		const delay = Math.max(0, minimumInterval - elapsed);
		if (delay === 0) {
			this.flush();
			return;
		}
		this.cancelTimer = this.clock.schedule(delay, () => {
			this.cancelTimer = undefined;
			this.flush();
		});
	}

	private flush(): void {
		if (this.pending === undefined || this.sending || this.stopped) return;
		const activity = this.pending;
		this.pending = undefined;
		this.sending = true;
		this.lastAttemptAt = this.clock.now();
		void this.transport.setActivity(activity).then(() => {
			this.lastSent = serialize(activity);
		}, () => {
			this.lastSent = undefined;
			if (this.pending === undefined) this.pending = activity;
		}).finally(() => {
			this.sending = false;
			if (this.pending !== undefined) {
				this.schedule(this.lastSent === undefined ? this.retryIntervalMs : this.updateIntervalMs);
			}
		});
	}
}

function serialize(activity: DiscordActivityPayload): string {
	return JSON.stringify(activity);
}

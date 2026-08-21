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
	private current: DiscordActivityPayload | undefined;
	private pending: DiscordActivityPayload | undefined;
	private lastSent: string | undefined;
	private lastAttemptAt = Number.NEGATIVE_INFINITY;
	private cancelTimer: (() => void) | undefined;
	private sending = false;
	private stopped = false;
	private generation = 0;
	private readonly unsubscribeStatus: () => void;

	constructor(
		private readonly transport: DiscordPresenceTransport,
		private updateIntervalMs: number,
		private retryIntervalMs: number,
		private readonly clock: PresenceClock = systemPresenceClock(),
	) {
		this.unsubscribeStatus = transport.onStatus((status) => {
			if (status !== "disconnected" || this.stopped) return;
			this.lastSent = undefined;
			if (this.pending === undefined) this.pending = this.current;
			if (this.pending !== undefined) this.schedule(this.retryIntervalMs);
		});
	}

	request(activity: DiscordActivityPayload): void {
		if (this.stopped) return;
		this.current = activity;
		const serialized = serialize(activity);
		if (serialized === this.lastSent && this.transport.getStatus() === "connected") return;
		this.pending = activity;
		this.schedule(this.updateIntervalMs);
	}

	configure(updateIntervalMs: number, retryIntervalMs: number): void {
		if (this.stopped) return;
		this.updateIntervalMs = updateIntervalMs;
		this.retryIntervalMs = retryIntervalMs;
		if (this.pending === undefined || this.sending) return;
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		this.schedule(this.lastSent === undefined ? this.retryIntervalMs : this.updateIntervalMs);
	}

	clear(): void {
		if (this.stopped) return;
		this.generation += 1;
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		this.current = undefined;
		this.pending = undefined;
		this.lastSent = undefined;
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.generation += 1;
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		this.current = undefined;
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
		const generation = this.generation;
		this.pending = undefined;
		this.sending = true;
		this.lastAttemptAt = this.clock.now();
		void this.transport.setActivity(activity).then(() => {
			if (!this.stopped && generation === this.generation) this.lastSent = serialize(activity);
		}, () => {
			if (this.stopped || generation !== this.generation) return;
			this.lastSent = undefined;
			if (this.pending === undefined) this.pending = activity;
		}).finally(() => {
			this.sending = false;
			if (!this.stopped && this.pending !== undefined) {
				const interval = generation === this.generation && this.lastSent === undefined
					? this.retryIntervalMs
					: this.updateIntervalMs;
				this.schedule(interval);
			}
		});
	}
}

function serialize(activity: DiscordActivityPayload): string {
	return JSON.stringify(activity);
}

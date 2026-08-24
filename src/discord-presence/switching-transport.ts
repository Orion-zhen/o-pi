import type { PresenceConnectionStatus } from "./types.js";
import type {
	DiscordPresenceTransport,
	DiscordPresenceTransportFactory,
} from "./transport.js";
import type { DiscordActivityPayload } from "./types.js";

/** 将协调器选中的 Application 映射到唯一 Discord RPC 连接。 */
export class SwitchingDiscordTransport implements DiscordPresenceTransport {
	private applicationId: string | undefined;
	private activeApplicationId: string | undefined;
	private transport: DiscordPresenceTransport | undefined;
	private unsubscribeStatus: (() => void) | undefined;
	private transition: Promise<void> = Promise.resolve();
	private status: PresenceConnectionStatus = "disconnected";
	private closed = false;
	private readonly listeners = new Set<(status: PresenceConnectionStatus) => void>();

	constructor(private readonly createTransport: DiscordPresenceTransportFactory) {}

	selectApplication(applicationId: string): void {
		if (this.closed) throw new Error("Discord transport is closed.");
		if (this.applicationId === applicationId) return;
		this.applicationId = applicationId;
		this.setStatus("connecting");
	}

	async setActivity(activity: DiscordActivityPayload): Promise<void> {
		await this.serializeTransition(async () => {
			const transport = await this.currentTransport();
			await transport.setActivity(activity);
			if (this.transport === transport) this.setStatus(transport.getStatus());
		});
	}

	async clearActivity(): Promise<void> {
		await this.serializeTransition(async () => {
			await this.disposeTransport(true);
		});
		if (!this.closed) this.setStatus("disconnected");
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.applicationId = undefined;
		await this.serializeTransition(async () => {
			await this.disposeTransport(true);
		});
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

	private async currentTransport(): Promise<DiscordPresenceTransport> {
		for (;;) {
			const selected = this.applicationId;
			if (this.closed || selected === undefined) throw new Error("Discord application is not selected.");
			if (this.transport !== undefined && this.activeApplicationId === selected) return this.transport;
			await this.disposeTransport(true);
			if (this.closed) throw new Error("Discord transport is closed.");
			if (this.applicationId !== selected) continue;
			const transport = await this.createTransport(selected);
			if (this.closed || this.applicationId !== selected) {
				await transport.close().catch(() => undefined);
				continue;
			}
			this.transport = transport;
			this.activeApplicationId = selected;
			this.unsubscribeStatus = transport.onStatus((status) => {
				if (this.transport === transport && this.applicationId === selected) this.setStatus(status);
			});
			return transport;
		}
	}

	private async disposeTransport(clear: boolean): Promise<void> {
		const transport = this.transport;
		this.transport = undefined;
		this.activeApplicationId = undefined;
		this.unsubscribeStatus?.();
		this.unsubscribeStatus = undefined;
		if (transport === undefined) return;
		if (clear) await transport.clearActivity().catch(() => undefined);
		await transport.close().catch(() => undefined);
	}

	private async serializeTransition(operation: () => Promise<void>): Promise<void> {
		const pending = this.transition.then(operation, operation);
		this.transition = pending.catch(() => undefined);
		await pending;
	}

	private setStatus(status: PresenceConnectionStatus): void {
		if (this.status === status) return;
		this.status = status;
		for (const listener of this.listeners) listener(status);
	}
}

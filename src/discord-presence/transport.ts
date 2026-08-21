import type { Client } from "@xhayper/discord-rpc";
import type { DiscordActivityPayload, PresenceConnectionStatus } from "./types.js";

const SHUTDOWN_TIMEOUT_MS = 2_000;

export interface DiscordPresenceTransport {
	setActivity(activity: DiscordActivityPayload): Promise<void>;
	clearActivity(): Promise<void>;
	close(): Promise<void>;
	getStatus(): PresenceConnectionStatus;
	onStatus(listener: (status: PresenceConnectionStatus) => void): () => void;
}

export type DiscordPresenceTransportFactory = (applicationId: string) => Promise<DiscordPresenceTransport>;

export async function createDiscordRpcTransport(applicationId: string): Promise<DiscordPresenceTransport> {
	const { Client: DiscordClient } = await import("@xhayper/discord-rpc");
	let client: Client | undefined;
	let connecting: Promise<Client> | undefined;
	let status: PresenceConnectionStatus = "disconnected";
	let closed = false;
	const listeners = new Set<(nextStatus: PresenceConnectionStatus) => void>();

	const setStatus = (nextStatus: PresenceConnectionStatus): void => {
		if (status === nextStatus) return;
		status = nextStatus;
		for (const listener of listeners) listener(nextStatus);
	};

	const discard = async (candidate: Client): Promise<void> => {
		if (client === candidate) client = undefined;
		await withTimeout(candidate.destroy(), SHUTDOWN_TIMEOUT_MS).catch(() => undefined);
	};

	const connect = (): Promise<Client> => {
		if (closed) return Promise.reject(new Error("Discord presence transport is closed."));
		if (client?.isConnected === true && client.user !== undefined) return Promise.resolve(client);
		if (connecting !== undefined) return connecting;
		setStatus("connecting");
		const candidate = new DiscordClient({ clientId: applicationId, transport: { type: "ipc" } });
		client = candidate;
		candidate.on("disconnected", () => {
			if (client !== candidate) return;
			client = undefined;
			setStatus("disconnected");
		});
		const pending = candidate.login().then(() => {
			if (candidate.user === undefined) throw new Error("Discord RPC connected without a local user.");
			if (closed) throw new Error("Discord presence transport closed while connecting.");
			client = candidate;
			setStatus("connected");
			return candidate;
		}).catch(async (error: unknown) => {
			await discard(candidate);
			setStatus(closed ? "disabled" : "disconnected");
			throw error;
		}).finally(() => {
			if (connecting === pending) connecting = undefined;
		});
		connecting = pending;
		return pending;
	};

	return {
		async setActivity(activity) {
			const connected = await connect();
			const user = connected.user;
			if (user === undefined) throw new Error("Discord RPC user is unavailable.");
			try {
				await user.setActivity(activity);
			} catch (error) {
				await discard(connected);
				setStatus("disconnected");
				throw error;
			}
		},
		async clearActivity() {
			const connected = client;
			if (connected?.isConnected !== true || connected.user === undefined) return;
			await withTimeout(connected.user.clearActivity(), SHUTDOWN_TIMEOUT_MS);
		},
		async close() {
			if (closed) return;
			closed = true;
			const connected = client;
			client = undefined;
			setStatus("disabled");
			if (connected !== undefined) await discard(connected);
		},
		getStatus: () => status,
		onStatus(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		handle = setTimeout(() => reject(new Error("Discord RPC operation timed out.")), timeoutMs);
		handle.unref();
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (handle !== undefined) clearTimeout(handle);
	}
}

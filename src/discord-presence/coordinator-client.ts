import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	parseServerMessage,
	readCoordinatorMessages,
	type CoordinatedActivity,
	type CoordinatedPresenceConfig,
	writeCoordinatorMessage,
} from "./coordinator-protocol.js";
import type { DiscordActivityPayload, PresenceConnectionStatus } from "./types.js";

const CONNECT_ATTEMPTS = 40;
const CONNECT_RETRY_MS = 50;
const HANDSHAKE_TIMEOUT_MS = 2_000;

export interface DiscordPresenceCoordinator {
	activate(
		config: CoordinatedPresenceConfig,
		joinedAt: number,
		activity?: DiscordActivityPayload,
	): Promise<void>;
	request(activity: DiscordActivityPayload): void;
	deactivate(): Promise<void>;
	getStatus(): PresenceConnectionStatus;
}

export interface DiscordPresenceCoordinatorOptions {
	endpoint?: string;
	participantId?: string;
	now?: () => number;
	spawnDaemon?: (endpoint: string) => void;
	handshakeTimeoutMs?: number;
}

/** 连接本机协调进程，并在协调进程退出后携带共享起点自动重连。 */
export class DiscordPresenceCoordinatorClient implements DiscordPresenceCoordinator {
	private readonly endpoint: string;
	private readonly participantId: string;
	private readonly now: () => number;
	private readonly spawnDaemon: (endpoint: string) => void;
	private readonly handshakeTimeoutMs: number;
	private config: CoordinatedPresenceConfig | undefined;
	private joinedAt: number | undefined;
	private continuityStartedAt: number | undefined;
	private presence: CoordinatedActivity | undefined;
	private socket: Socket | undefined;
	private connecting: Promise<void> | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private status: PresenceConnectionStatus = "disabled";
	private active = false;
	private generation = 0;

	constructor(options: DiscordPresenceCoordinatorOptions = {}) {
		this.endpoint = options.endpoint ?? defaultCoordinatorEndpoint();
		this.participantId = options.participantId ?? randomUUID();
		this.now = options.now ?? Date.now;
		this.spawnDaemon = options.spawnDaemon ?? spawnCoordinatorDaemon;
		this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
	}

	async activate(
		config: CoordinatedPresenceConfig,
		joinedAt: number,
		activity?: DiscordActivityPayload,
	): Promise<void> {
		const wasActive = this.active;
		const generation = this.generation;
		this.active = true;
		this.config = config;
		if (!wasActive) {
			this.joinedAt = joinedAt;
			this.continuityStartedAt = undefined;
			this.setStatus("disconnected");
		}
		const nextPresence = activity === undefined ? undefined : { activity, activeAt: this.now() };
		if (nextPresence !== undefined) this.presence = nextPresence;
		if (this.socket !== undefined && !this.socket.destroyed) {
			writeCoordinatorMessage(this.socket, { type: "configure", config });
			if (nextPresence !== undefined) writeCoordinatorMessage(this.socket, { type: "activity", ...nextPresence });
			return;
		}
		try {
			await prepareCoordinatorEndpoint(this.endpoint);
		} catch (error) {
			if (!wasActive && generation === this.generation) await this.deactivate();
			throw error;
		}
		if (!this.active || generation !== this.generation) return;
		void this.ensureConnected().catch(() => undefined);
	}

	request(activity: DiscordActivityPayload): void {
		if (!this.active) throw new Error("Discord presence coordinator is not active.");
		const presence = { activity, activeAt: this.now() };
		this.presence = presence;
		const socket = this.socket;
		if (socket !== undefined && !socket.destroyed) {
			writeCoordinatorMessage(socket, { type: "activity", ...presence });
		}
	}

	async deactivate(): Promise<void> {
		if (!this.active && this.socket === undefined) return;
		this.active = false;
		const generation = ++this.generation;
		this.config = undefined;
		this.joinedAt = undefined;
		this.continuityStartedAt = undefined;
		this.presence = undefined;
		if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		const socket = this.socket;
		this.socket = undefined;
		if (socket !== undefined) await endSocket(socket);
		if (!this.active && generation === this.generation) this.setStatus("disabled");
	}

	getStatus(): PresenceConnectionStatus {
		return this.status;
	}

	private ensureConnected(): Promise<void> {
		if (!this.active) return Promise.resolve();
		if (this.socket !== undefined && !this.socket.destroyed) return Promise.resolve();
		if (this.connecting !== undefined) return this.connecting;
		const generation = this.generation;
		const pending = this.connectLoop(generation).finally(() => {
			if (this.connecting === pending) this.connecting = undefined;
		});
		this.connecting = pending;
		return pending;
	}

	private async connectLoop(generation: number): Promise<void> {
		await prepareCoordinatorEndpoint(this.endpoint);
		let attempts = 0;
		let daemonStarted = false;
		while (this.active && generation === this.generation) {
			this.setStatus("connecting");
			try {
				await this.connectOnce(generation);
				return;
			} catch (error) {
				if (!this.active || generation !== this.generation) return;
				this.setStatus("disconnected");
				attempts += 1;
				if (!daemonStarted) {
					this.spawnDaemon(this.endpoint);
					daemonStarted = true;
				}
				if (attempts === CONNECT_ATTEMPTS) {
					this.scheduleReconnect();
					throw error;
				}
				await delay(CONNECT_RETRY_MS);
			}
		}
	}

	private async connectOnce(generation: number): Promise<void> {
		if (!this.active) return;
		const socket = await openSocket(this.endpoint);
		const config = this.config;
		const joinedAt = this.joinedAt;
		if (
			!this.active
			|| generation !== this.generation
			|| config === undefined
			|| joinedAt === undefined
		) {
			socket.destroy();
			return;
		}
		this.socket = socket;
		socket.unref();
		let settled = false;
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				finish(new Error("Discord presence coordinator handshake timed out."));
				socket.destroy();
			}, this.handshakeTimeoutMs);
			timeout.unref();
			const finish = (error?: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (error === undefined) resolve();
				else reject(error);
			};
			const removeReader = readCoordinatorMessages(socket, (value) => {
				try {
					const message = parseServerMessage(value);
					if (message.type === "error") {
						finish(new Error(message.message));
						socket.destroy();
						return;
					}
					this.continuityStartedAt = message.groupStartedAt;
					this.setStatus(message.status);
					finish();
				} catch (error) {
					if (!(error instanceof Error)) throw error;
					finish(error);
					socket.destroy();
				}
			}, (error) => {
				finish(error);
				socket.destroy();
			});
			socket.on("error", (error) => finish(error));
			socket.once("close", () => {
				removeReader();
				finish(new Error("Discord presence coordinator disconnected."));
				if (this.socket === socket) {
					this.socket = undefined;
					if (this.active && generation === this.generation) {
						this.setStatus("disconnected");
						this.scheduleReconnect();
					}
				}
			});
			writeCoordinatorMessage(socket, {
				type: "register",
				participantId: this.participantId,
				joinedAt,
				...(this.continuityStartedAt === undefined ? {} : { continuityStartedAt: this.continuityStartedAt }),
				config,
				...(this.presence ?? {}),
			});
		});
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer !== undefined || !this.active) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.ensureConnected().catch(() => this.scheduleReconnect());
		}, CONNECT_RETRY_MS);
		this.reconnectTimer.unref();
	}

	private setStatus(status: PresenceConnectionStatus): void {
		if (this.status === status) return;
		this.status = status;
	}
}

export function defaultCoordinatorEndpoint(): string {
	const identity = typeof process.getuid === "function"
		? String(process.getuid())
		: createHash("sha256").update(os.homedir()).digest("hex").slice(0, 16);
	if (process.platform === "win32") return `\\\\.\\pipe\\o-pi-discord-presence-${identity}`;
	return path.join(os.tmpdir(), `o-pi-${identity}`, "discord-presence.sock");
}

export async function prepareCoordinatorEndpoint(endpoint: string): Promise<void> {
	if (process.platform === "win32") return;
	const directory = path.dirname(endpoint);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const details = await stat(directory);
	if (!details.isDirectory()) throw new Error("Discord presence coordinator path is not a directory.");
	if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
		throw new Error("Discord presence coordinator directory is owned by another user.");
	}
	await chmod(directory, 0o700);
}

export function spawnCoordinatorDaemon(endpoint: string): void {
	const entry = fileURLToPath(new URL("./coordinator-daemon.ts", import.meta.url));
	const jitiRegister = import.meta.resolve("jiti/register");
	const child = spawn(process.execPath, ["--import", jitiRegister, entry, endpoint], {
		cwd: fileURLToPath(new URL("../..", import.meta.url)),
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	child.unref();
}

function openSocket(endpoint: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(endpoint);
		const onConnect = (): void => {
			socket.off("error", onError);
			resolve(socket);
		};
		const onError = (error: Error): void => {
			socket.off("connect", onConnect);
			socket.destroy();
			reject(error);
		};
		socket.once("connect", onConnect);
		socket.once("error", onError);
	});
}

function endSocket(socket: Socket): Promise<void> {
	return new Promise((resolve) => {
		if (socket.destroyed) {
			resolve();
			return;
		}
		const timeout = setTimeout(() => socket.destroy(), 500);
		timeout.unref();
		socket.once("close", () => {
			clearTimeout(timeout);
			resolve();
		});
		socket.end();
	});
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		const timeout = setTimeout(resolve, milliseconds);
		timeout.unref();
	});
}

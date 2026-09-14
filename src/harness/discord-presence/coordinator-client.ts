import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { cliInvocation } from "../runtime/invocation.ts";
import { defaultCoordinatorEndpoint, prepareCoordinatorEndpoint } from "./endpoint.ts";
import {
	parseServerMessage,
	readCoordinatorMessages,
	writeCoordinatorMessage,
	type CoordinatedActivity,
	type CoordinatedPresenceConfig,
} from "./coordinator-protocol.ts";
import type { DiscordActivityPayload, PresenceConnectionStatus } from "./types.ts";

const CONNECT_RETRY_MS = 50;
const DAEMON_RETRY_MS = 2_000;
const HANDSHAKE_TIMEOUT_MS = 2_000;

interface Registration {
	config: CoordinatedPresenceConfig;
	joinedAt: number;
	continuityStartedAt: number | undefined;
	presence: CoordinatedActivity | undefined;
	controller: AbortController;
	prepared: Promise<void>;
	task?: Promise<void>;
}

/** 每次启用只启动一个可取消的连接任务，断线时携带最后状态重新注册。 */
export class DiscordPresenceCoordinatorClient {
	private readonly endpoint = defaultCoordinatorEndpoint();
	private readonly participantId = randomUUID();
	private registration: Registration | undefined;
	private socket: Socket | undefined;
	private status: PresenceConnectionStatus = "disabled";

	async activate(config: CoordinatedPresenceConfig, joinedAt: number, activity?: DiscordActivityPayload): Promise<void> {
		let registration = this.registration;
		if (registration === undefined) {
			registration = {
				config,
				joinedAt,
				continuityStartedAt: undefined,
				presence: undefined,
				controller: new AbortController(),
				prepared: prepareCoordinatorEndpoint(this.endpoint),
			};
			this.registration = registration;
			this.status = "disconnected";
		}
		registration.config = config;
		if (activity !== undefined) registration.presence = { activity, activeAt: Date.now() };
		try {
			await registration.prepared;
		} catch (error) {
			if (this.registration === registration) await this.deactivate();
			throw error;
		}
		if (this.registration !== registration) return;
		if (registration.task === undefined) registration.task = this.connectLoop(registration);
		if (this.socket !== undefined) {
			writeCoordinatorMessage(this.socket, { type: "configure", config: registration.config });
			if (activity !== undefined && registration.presence !== undefined) {
				writeCoordinatorMessage(this.socket, { type: "activity", ...registration.presence });
			}
		}
	}

	request(activity: DiscordActivityPayload): void {
		const registration = this.registration;
		if (registration === undefined) throw new Error("Discord presence coordinator is not active.");
		registration.presence = { activity, activeAt: Date.now() };
		if (this.socket !== undefined) writeCoordinatorMessage(this.socket, { type: "activity", ...registration.presence });
	}

	async deactivate(): Promise<void> {
		const registration = this.registration;
		if (registration === undefined) return;
		this.registration = undefined;
		this.socket = undefined;
		registration.controller.abort();
		await registration.task;
		if (this.registration === undefined) this.status = "disabled";
	}

	getStatus(): PresenceConnectionStatus { return this.status; }

	private async connectLoop(registration: Registration): Promise<void> {
		const { signal } = registration.controller;
		let nextSpawnAt = 0;
		while (!signal.aborted) {
			this.status = "connecting";
			try {
				await this.connect(registration);
			} catch {
				if (signal.aborted) return;
				this.status = "disconnected";
				if (Date.now() >= nextSpawnAt) {
					spawnCoordinatorDaemon(this.endpoint);
					nextSpawnAt = Date.now() + DAEMON_RETRY_MS;
				}
			}
			try {
				await delay(CONNECT_RETRY_MS, undefined, { signal, ref: false });
			} catch (error) {
				if (!signal.aborted) throw error;
			}
		}
	}

	private connect(registration: Registration): Promise<void> {
		return new Promise((_resolve, reject) => {
			const { signal } = registration.controller;
			const socket = createConnection({ path: this.endpoint, signal });
			socket.unref();
			let failure = new Error("Discord presence coordinator disconnected.");
			let sentConfig: CoordinatedPresenceConfig;
			let sentPresence: CoordinatedActivity | undefined;
			const timeout = setTimeout(() => {
				socket.destroy(new Error("Discord presence coordinator handshake timed out."));
			}, HANDSHAKE_TIMEOUT_MS);
			timeout.unref();
			const removeReader = readCoordinatorMessages(socket, (value) => {
				if (signal.aborted) return;
				try {
					const message = parseServerMessage(value);
					if (message.type === "error") throw new Error(message.message);
					clearTimeout(timeout);
					registration.continuityStartedAt = message.groupStartedAt;
					this.status = message.status;
					if (this.socket !== socket) {
						this.socket = socket;
						// 注册发出到握手完成之间可能收到配置和活动更新。
						if (registration.config !== sentConfig) {
							writeCoordinatorMessage(socket, { type: "configure", config: registration.config });
						}
						if (registration.presence !== undefined && registration.presence !== sentPresence) {
							writeCoordinatorMessage(socket, { type: "activity", ...registration.presence });
						}
					}
				} catch (error) {
					socket.destroy(error instanceof Error ? error : new Error(String(error)));
				}
			}, (error) => socket.destroy(error));
			socket.once("connect", () => {
				sentConfig = registration.config;
				sentPresence = registration.presence;
				writeCoordinatorMessage(socket, {
					type: "register", participantId: this.participantId, joinedAt: registration.joinedAt,
					...(registration.continuityStartedAt === undefined ? {} : { continuityStartedAt: registration.continuityStartedAt }),
					config: sentConfig, ...(sentPresence ?? {}),
				});
			});
			socket.on("error", (error) => { failure = error; });
			socket.once("close", () => {
				clearTimeout(timeout);
				removeReader();
				if (this.socket === socket) this.socket = undefined;
				reject(failure);
			});
		});
	}
}

function spawnCoordinatorDaemon(endpoint: string): void {
	const invocation = cliInvocation(["--opi-discord-daemon", endpoint]);
	const child = spawn(invocation.command, invocation.args, {
		cwd: process.cwd(),
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	// 启动失败与端点暂时不可用同样由连接任务按固定节奏重试。
	child.on("error", () => {});
	child.unref();
}

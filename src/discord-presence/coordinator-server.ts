import { chmod, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import {
	CoordinatorProtocolError,
	parseClientMessage,
	readCoordinatorMessages,
	type CoordinatedPresenceConfig,
	writeCoordinatorMessage,
} from "./coordinator-protocol.js";
import { PresencePublisher, type PresenceClock } from "./publisher.js";
import { SwitchingDiscordTransport } from "./switching-transport.js";
import { createDiscordRpcTransport, type DiscordPresenceTransportFactory } from "./transport.js";
import type { DiscordActivityPayload, PresenceConnectionStatus } from "./types.js";

interface Participant {
	config: CoordinatedPresenceConfig;
	joinedAt: number;
	activity?: DiscordActivityPayload;
	activeAt?: number;
	order: number;
}

export interface SelectedPresence {
	participantId: string;
	config: CoordinatedPresenceConfig;
	activity: DiscordActivityPayload;
	groupStartedAt: number;
}

export interface PresenceCoordinatorOutput {
	show(selection: SelectedPresence): void;
	hide(): Promise<void>;
	clear(): Promise<void>;
	getStatus(): PresenceConnectionStatus;
	onStatus(listener: (status: PresenceConnectionStatus) => void): () => void;
}

export interface PresenceBrokerOptions {
	output: PresenceCoordinatorOutput;
	onChange?: () => void;
	onEmpty?: () => void;
}

/** 维护参与者、最近活动选择和跨进程共享计时。 */
export class PresenceBroker {
	private readonly participants = new Map<string, Participant>();
	private selectedParticipantId: string | undefined;
	private groupStartedAt: number | undefined;
	private order = 0;

	constructor(private readonly options: PresenceBrokerOptions) {}

	register(
		participantId: string,
		config: CoordinatedPresenceConfig,
		joinedAt: number,
		continuityStartedAt?: number,
		activity?: DiscordActivityPayload,
		activeAt?: number,
	): void {
		const candidateStart = Math.min(joinedAt, continuityStartedAt ?? joinedAt);
		const previousStart = this.groupStartedAt;
		this.groupStartedAt = previousStart === undefined ? candidateStart : Math.min(previousStart, candidateStart);
		const previous = this.participants.get(participantId);
		this.participants.set(participantId, {
			config,
			joinedAt,
			...(activity === undefined || activeAt === undefined ? {} : { activity, activeAt }),
			order: previous?.order ?? ++this.order,
		});
		if (activity !== undefined) this.selectLatest();
		else if (previousStart !== this.groupStartedAt) this.showSelected();
		this.options.onChange?.();
	}

	configure(participantId: string, config: CoordinatedPresenceConfig): void {
		const participant = this.participants.get(participantId);
		if (participant === undefined) throw new CoordinatorProtocolError("Coordinator participant is not registered.");
		participant.config = config;
		if (this.selectedParticipantId === participantId) this.showSelected();
	}

	publish(participantId: string, activity: DiscordActivityPayload, activeAt: number): void {
		const participant = this.participants.get(participantId);
		if (participant === undefined) throw new CoordinatorProtocolError("Coordinator participant is not registered.");
		participant.activity = activity;
		participant.activeAt = activeAt;
		participant.order = ++this.order;
		this.selectLatest();
	}

	remove(participantId: string): void {
		if (!this.participants.delete(participantId)) return;
		if (this.participants.size === 0) {
			this.selectedParticipantId = undefined;
			this.groupStartedAt = undefined;
			void this.options.output.clear();
			this.options.onChange?.();
			this.options.onEmpty?.();
			return;
		}
		if (this.selectedParticipantId === participantId) this.selectLatest();
		this.options.onChange?.();
	}

	startedAt(): number | undefined {
		return this.groupStartedAt;
	}

	participantCount(): number {
		return this.participants.size;
	}

	private selectLatest(): void {
		let selectedId: string | undefined;
		let selected: Participant | undefined;
		for (const [participantId, participant] of this.participants) {
			if (participant.activity === undefined || participant.activeAt === undefined) continue;
			if (
				selected === undefined
				|| participant.activeAt > (selected.activeAt ?? Number.NEGATIVE_INFINITY)
				|| (participant.activeAt === selected.activeAt && participant.order > selected.order)
			) {
				selectedId = participantId;
				selected = participant;
			}
		}
		this.selectedParticipantId = selectedId;
		if (selectedId === undefined) void this.options.output.hide();
		else this.showSelected();
	}

	private showSelected(): void {
		const participantId = this.selectedParticipantId;
		const startedAt = this.groupStartedAt;
		if (participantId === undefined || startedAt === undefined) return;
		const participant = this.participants.get(participantId);
		if (participant?.activity === undefined) return;
		const activity = participant.activity.startTimestamp === undefined
			? participant.activity
			: { ...participant.activity, startTimestamp: startedAt };
		this.options.output.show({ participantId, config: participant.config, activity, groupStartedAt: startedAt });
	}
}

export interface DiscordCoordinatorOutputOptions {
	createTransport?: DiscordPresenceTransportFactory;
	clock?: PresenceClock;
}

export class DiscordCoordinatorOutput implements PresenceCoordinatorOutput {
	private readonly transport: SwitchingDiscordTransport;
	private readonly publisher: PresencePublisher;

	constructor(options: DiscordCoordinatorOutputOptions = {}) {
		this.transport = new SwitchingDiscordTransport(options.createTransport ?? createDiscordRpcTransport);
		this.publisher = new PresencePublisher(this.transport, 5_000, 30_000, options.clock);
	}

	show(selection: SelectedPresence): void {
		this.transport.selectApplication(selection.config.applicationId);
		this.publisher.configure(selection.config.updateIntervalMs, selection.config.retryIntervalMs);
		this.publisher.request(selection.activity);
	}

	async hide(): Promise<void> {
		this.publisher.clear();
		await this.transport.clearActivity();
	}

	async clear(): Promise<void> {
		this.publisher.stop();
		await this.transport.clearActivity();
		await this.transport.close();
	}

	getStatus(): PresenceConnectionStatus {
		return this.transport.getStatus();
	}

	onStatus(listener: (status: PresenceConnectionStatus) => void): () => void {
		return this.transport.onStatus(listener);
	}
}

export interface PresenceCoordinatorServerOptions {
	endpoint: string;
	output?: PresenceCoordinatorOutput;
	createTransport?: DiscordPresenceTransportFactory;
	clock?: PresenceClock;
	onEmpty?: () => void;
}

export interface PresenceCoordinatorServer {
	listen(): Promise<void>;
	close(): Promise<void>;
	participantCount(): number;
}

export function createPresenceCoordinatorServer(options: PresenceCoordinatorServerOptions): PresenceCoordinatorServer {
	const output = options.output ?? new DiscordCoordinatorOutput({
		...(options.createTransport === undefined ? {} : { createTransport: options.createTransport }),
		...(options.clock === undefined ? {} : { clock: options.clock }),
	});
	const sockets = new Set<Socket>();
	const participantSockets = new Map<string, Socket>();
	let server: Server | undefined;
	let closing: Promise<void> | undefined;
	const broadcastStatus = (): void => {
		const groupStartedAt = broker.startedAt();
		if (groupStartedAt === undefined) return;
		for (const socket of participantSockets.values()) {
			writeCoordinatorMessage(socket, { type: "status", status: output.getStatus(), groupStartedAt });
		}
	};
	const broker = new PresenceBroker({
		output,
		onChange: broadcastStatus,
		...(options.onEmpty === undefined ? {} : { onEmpty: options.onEmpty }),
	});
	const unsubscribeStatus = output.onStatus(broadcastStatus);

	return {
		async listen() {
			if (closing !== undefined) throw new Error("Discord presence coordinator server is closed.");
			if (server !== undefined) return;
			if (process.platform !== "win32") await mkdir(path.dirname(options.endpoint), { recursive: true, mode: 0o700 });
			server = createServer((socket) => {
				sockets.add(socket);
				socket.unref();
				let participantId: string | undefined;
				let registered = false;
				const removeReader = readCoordinatorMessages(socket, (value) => {
					try {
						const message = parseClientMessage(value);
						if (message.type === "register") {
							if (registered) throw new CoordinatorProtocolError("Coordinator socket is already registered.");
							registered = true;
							participantId = message.participantId;
							const previousSocket = participantSockets.get(participantId);
							participantSockets.set(participantId, socket);
							if (previousSocket !== undefined && previousSocket !== socket) previousSocket.destroy();
							broker.register(
								participantId,
								message.config,
								message.joinedAt,
								message.continuityStartedAt,
								message.activity,
								message.activeAt,
							);
							broadcastStatus();
							return;
						}
						if (!registered || participantId === undefined) {
							throw new CoordinatorProtocolError("Coordinator socket must register first.");
						}
						if (message.type === "configure") broker.configure(participantId, message.config);
						else broker.publish(participantId, message.activity, message.activeAt);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						writeCoordinatorMessage(socket, { type: "error", message });
						socket.destroy();
					}
				}, () => socket.destroy());
				socket.on("error", () => undefined);
				socket.once("close", () => {
					removeReader();
					sockets.delete(socket);
					if (participantId !== undefined && participantSockets.get(participantId) === socket) {
						participantSockets.delete(participantId);
						broker.remove(participantId);
					}
				});
			});
			await listen(server, options.endpoint);
			if (process.platform !== "win32") await chmod(options.endpoint, 0o600).catch(() => undefined);
		},
		close() {
			if (closing !== undefined) return closing;
			closing = (async () => {
				unsubscribeStatus();
				for (const socket of sockets) socket.destroy();
				const activeServer = server;
				server = undefined;
				if (activeServer !== undefined) await closeServer(activeServer);
				await output.clear().catch(() => undefined);
				if (process.platform !== "win32") await unlink(options.endpoint).catch(() => undefined);
			})();
			return closing;
		},
		participantCount: () => broker.participantCount(),
	};
}

function listen(server: Server, endpoint: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error): void => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(endpoint);
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		if (!server.listening) {
			resolve();
			return;
		}
		server.close(() => resolve());
	});
}

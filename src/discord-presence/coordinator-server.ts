import { chmod, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import {
	CoordinatorProtocolError,
	parseClientMessage,
	readCoordinatorMessages,
	type CoordinatedActivity,
	type CoordinatedPresenceConfig,
	writeCoordinatorMessage,
} from "./coordinator-protocol.js";
import { DiscordCoordinatorOutput } from "./output.js";
import type { DiscordActivityPayload } from "./types.js";

interface Participant {
	config: CoordinatedPresenceConfig;
	presence?: CoordinatedActivity;
	order: number;
}

interface PresenceBrokerOptions {
	output: DiscordCoordinatorOutput;
	onChange: () => void;
	onEmpty: () => void;
}

/** 维护参与者、最近活动选择和跨进程共享计时。 */
class PresenceBroker {
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
		presence?: CoordinatedActivity,
	): void {
		const candidateStart = Math.min(joinedAt, continuityStartedAt ?? joinedAt);
		const previousStart = this.groupStartedAt;
		this.groupStartedAt = previousStart === undefined ? candidateStart : Math.min(previousStart, candidateStart);
		const previous = this.participants.get(participantId);
		this.participants.set(participantId, {
			config,
			...(presence === undefined ? {} : { presence }),
			order: previous?.order ?? ++this.order,
		});
		if (presence !== undefined) this.selectLatest();
		else if (previousStart !== this.groupStartedAt && this.selectedParticipantId !== undefined) this.showSelected();
		this.options.onChange();
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
		participant.presence = { activity, activeAt };
		participant.order = ++this.order;
		this.selectLatest();
	}

	remove(participantId: string): void {
		if (!this.participants.delete(participantId)) return;
		if (this.participants.size === 0) {
			this.selectedParticipantId = undefined;
			this.groupStartedAt = undefined;
			this.options.onChange();
			this.options.onEmpty();
			return;
		}
		if (this.selectedParticipantId === participantId) this.selectLatest();
		this.options.onChange();
	}

	startedAt(): number | undefined {
		return this.groupStartedAt;
	}

	participantCount(): number {
		return this.participants.size;
	}

	private selectLatest(): void {
		let selectedId: string | undefined;
		let selected: { presence: CoordinatedActivity; order: number } | undefined;
		for (const [participantId, participant] of this.participants) {
			const presence = participant.presence;
			if (presence === undefined) continue;
			if (
				selected === undefined
				|| presence.activeAt > selected.presence.activeAt
				|| (presence.activeAt === selected.presence.activeAt && participant.order > selected.order)
			) {
				selectedId = participantId;
				selected = { presence, order: participant.order };
			}
		}
		this.selectedParticipantId = selectedId;
		if (selectedId === undefined) void this.options.output.hide();
		else this.showSelected();
	}

	private showSelected(): void {
		const participantId = this.selectedParticipantId;
		const startedAt = this.groupStartedAt;
		if (participantId === undefined || startedAt === undefined) {
			throw new Error("Discord presence selection is incomplete.");
		}
		const participant = this.participants.get(participantId);
		if (participant?.presence === undefined) throw new Error("Discord presence participant is unavailable.");
		const activity = participant.presence.activity.startTimestamp === undefined
			? participant.presence.activity
			: { ...participant.presence.activity, startTimestamp: startedAt };
		this.options.output.show({ config: participant.config, activity });
	}
}

interface PresenceCoordinatorServerOptions {
	endpoint: string;
	onEmpty: () => void;
}

export interface PresenceCoordinatorServer {
	listen(): Promise<void>;
	close(): Promise<void>;
	participantCount(): number;
}

export function createPresenceCoordinatorServer(options: PresenceCoordinatorServerOptions): PresenceCoordinatorServer {
	const output = new DiscordCoordinatorOutput();
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
		onEmpty: options.onEmpty,
	});
	const unsubscribeStatus = output.onStatus(broadcastStatus);

	return {
		async listen() {
			if (closing !== undefined) throw new Error("Discord presence coordinator server is closed.");
			if (server !== undefined) return;
			server = createServer((socket) => {
				sockets.add(socket);
				socket.unref();
				let participantId: string | undefined;
				const removeReader = readCoordinatorMessages(socket, (value) => {
					try {
						const message = parseClientMessage(value);
						if (message.type === "register") {
							if (participantId !== undefined) throw new CoordinatorProtocolError("Coordinator socket is already registered.");
							participantId = message.participantId;
							const previousSocket = participantSockets.get(participantId);
							participantSockets.set(participantId, socket);
							if (previousSocket !== undefined && previousSocket !== socket) previousSocket.destroy();
							broker.register(
								participantId,
								message.config,
								message.joinedAt,
								message.continuityStartedAt,
								message.activity === undefined
									? undefined
									: { activity: message.activity, activeAt: message.activeAt },
							);
							return;
						}
						if (participantId === undefined) {
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
				await output.dispose();
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

import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { prepareOPetEndpoint, resolveOPetEndpoint } from "./endpoint.js";
import {
	serializeOPetMessage,
	type OPetEvent,
} from "./protocol.js";

const MAX_PENDING_EVENTS = 256;

export interface OPetSocket {
	write(data: string): boolean;
	end(data: string): void;
	destroy(): void;
	unref(): void;
}

export interface OPetSocketCallbacks {
	connect(): void;
	drain(): void;
	error(error: Error): void;
	close(): void;
}

export type OPetConnector = (endpoint: string, callbacks: OPetSocketCallbacks) => OPetSocket;

export interface OPetClientOptions {
	clientId?: string;
	endpoint?: string;
	connector?: OPetConnector;
	prepareEndpoint?: (endpoint: string) => Promise<void>;
}

export interface OPetEventClient {
	startSession(sessionId: string): void;
	publish(event: OPetEvent): void;
	shutdown(): void;
}

/** 按状态事件惰性连接桌宠；连接不可用时保留有限数量的最近转换。 */
export class OPetClient implements OPetEventClient {
	private readonly clientId: string;
	private readonly endpoint: string | undefined;
	private readonly connector: OPetConnector;
	private readonly prepareEndpoint: (endpoint: string) => Promise<void>;
	private sessionId: string | undefined;
	private readonly pendingEvents: OPetEvent[] = [];
	private socket: OPetSocket | undefined;
	private connected = false;
	private blocked = false;
	private preparing = false;

	constructor(options: OPetClientOptions = {}) {
		this.clientId = options.clientId ?? randomUUID();
		this.endpoint = options.endpoint;
		this.connector = options.connector ?? connectOPetSocket;
		this.prepareEndpoint = options.prepareEndpoint ?? prepareOPetEndpoint;
	}

	startSession(sessionId: string): void {
		this.sessionId = sessionId;
		this.connectIfNeeded();
	}

	publish(event: OPetEvent): void {
		if (this.sessionId === undefined) return;
		this.pendingEvents.push(event);
		if (this.pendingEvents.length > MAX_PENDING_EVENTS) this.pendingEvents.shift();
		const socket = this.socket;
		if (socket !== undefined && this.connected && !this.blocked) this.writePendingEvents(socket);
		else this.connectIfNeeded();
	}

	shutdown(): void {
		const wasConnected = this.connected;
		this.sessionId = undefined;
		this.pendingEvents.length = 0;
		this.preparing = false;
		this.connected = false;
		this.blocked = false;
		const socket = this.socket;
		this.socket = undefined;
		if (socket === undefined) return;
		if (!wasConnected) {
			socket.destroy();
			return;
		}
		try {
			socket.end(serializeOPetMessage({ type: "goodbye" }));
		} catch {
			socket.destroy();
		}
	}

	private connectIfNeeded(): void {
		if (this.sessionId === undefined || this.socket !== undefined || this.preparing) return;
		this.preparing = true;
		void this.openSocket()
			.catch(() => {})
			.finally(() => {
				this.preparing = false;
			});
	}

	private async openSocket(): Promise<void> {
		const endpoint = this.endpoint ?? resolveOPetEndpoint();
		await this.prepareEndpoint(endpoint);
		if (this.sessionId === undefined) return;
		let socket: OPetSocket;
		socket = this.connector(endpoint, {
			connect: () => this.onConnect(socket),
			drain: () => this.onDrain(socket),
			error: () => this.onDisconnect(socket),
			close: () => this.onDisconnect(socket),
		});
		this.socket = socket;
		socket.unref();
	}

	private onConnect(socket: OPetSocket): void {
		const sessionId = this.sessionId;
		if (this.socket !== socket || sessionId === undefined) {
			socket.destroy();
			return;
		}
		this.connected = true;
		try {
			this.blocked = !socket.write(serializeOPetMessage({
				type: "hello",
				clientId: this.clientId,
				sessionId,
			}));
		} catch {
			this.onDisconnect(socket);
			return;
		}
		if (!this.blocked) this.writePendingEvents(socket);
	}

	private onDrain(socket: OPetSocket): void {
		if (this.socket !== socket || !this.connected) return;
		this.blocked = false;
		this.writePendingEvents(socket);
	}

	private onDisconnect(socket: OPetSocket): void {
		if (this.socket !== socket) return;
		this.socket = undefined;
		this.connected = false;
		this.blocked = false;
		socket.destroy();
	}

	private writePendingEvents(socket: OPetSocket): void {
		if (this.pendingEvents.length === 0) return;
		const payload = this.pendingEvents
			.map((event) => serializeOPetMessage({ type: "event", event }))
			.join("");
		try {
			this.blocked = !socket.write(payload);
			this.pendingEvents.length = 0;
		} catch {
			this.onDisconnect(socket);
		}
	}
}

export function connectOPetSocket(endpoint: string, callbacks: OPetSocketCallbacks): OPetSocket {
	const socket = new Socket();
	socket.once("connect", callbacks.connect);
	socket.on("drain", callbacks.drain);
	socket.on("error", callbacks.error);
	socket.once("close", callbacks.close);
	socket.connect(endpoint);
	return socket;
}

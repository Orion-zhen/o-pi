import type { Socket } from "node:net";
import type { DiscordActivityPayload, PresenceConnectionStatus } from "./types.js";

const MAX_MESSAGE_BYTES = 32 * 1024;
const APPLICATION_ID = /^\d{17,20}$/u;

export interface CoordinatedPresenceConfig {
	applicationId: string;
	updateIntervalMs: number;
	retryIntervalMs: number;
}

export interface RegisterMessage {
	type: "register";
	participantId: string;
	joinedAt: number;
	continuityStartedAt?: number;
	config: CoordinatedPresenceConfig;
	activity?: DiscordActivityPayload;
	activeAt?: number;
}

export interface ConfigureMessage {
	type: "configure";
	config: CoordinatedPresenceConfig;
}

export interface ActivityMessage {
	type: "activity";
	activity: DiscordActivityPayload;
	activeAt: number;
}

export type CoordinatorClientMessage = RegisterMessage | ConfigureMessage | ActivityMessage;

export interface CoordinatorStatusMessage {
	type: "status";
	status: PresenceConnectionStatus;
	groupStartedAt: number;
}

export interface CoordinatorErrorMessage {
	type: "error";
	message: string;
}

export type CoordinatorServerMessage = CoordinatorStatusMessage | CoordinatorErrorMessage;

export class CoordinatorProtocolError extends Error {}

export function writeCoordinatorMessage(socket: Socket, message: CoordinatorClientMessage | CoordinatorServerMessage): void {
	if (socket.destroyed) return;
	socket.write(`${JSON.stringify(message)}\n`);
}

export function readCoordinatorMessages(
	socket: Socket,
	onMessage: (value: unknown) => void,
	onError: (error: Error) => void,
): () => void {
	let buffered = Buffer.alloc(0);
	const onData = (chunk: Buffer): void => {
		buffered = Buffer.concat([buffered, chunk]);
		if (buffered.length > MAX_MESSAGE_BYTES && buffered.indexOf(0x0a) < 0) {
			onError(new CoordinatorProtocolError("Coordinator message exceeds the size limit."));
			return;
		}
		for (;;) {
			const newline = buffered.indexOf(0x0a);
			if (newline < 0) return;
			const line = buffered.subarray(0, newline);
			buffered = buffered.subarray(newline + 1);
			if (line.length === 0) continue;
			if (line.length > MAX_MESSAGE_BYTES) {
				onError(new CoordinatorProtocolError("Coordinator message exceeds the size limit."));
				return;
			}
			try {
				const parsed: unknown = JSON.parse(line.toString("utf8"));
				onMessage(parsed);
			} catch {
				onError(new CoordinatorProtocolError("Coordinator message is not valid JSON."));
				return;
			}
		}
	};
	socket.on("data", onData);
	return () => socket.off("data", onData);
}

export function parseClientMessage(value: unknown): CoordinatorClientMessage {
	const record = requiredRecord(value, "Coordinator client message must be an object.");
	const type = record["type"];
	if (type === "register") {
		const activity = record["activity"] === undefined ? undefined : parseActivity(record["activity"]);
		const activeAt = record["activeAt"] === undefined ? undefined : timestamp(record["activeAt"], "activeAt");
		if ((activity === undefined) !== (activeAt === undefined)) {
			throw new CoordinatorProtocolError("register activity and activeAt must be provided together.");
		}
		const base: Omit<RegisterMessage, "activity" | "activeAt"> = {
			type: "register",
			participantId: nonEmptyString(record["participantId"], "participantId", 128),
			joinedAt: timestamp(record["joinedAt"], "joinedAt"),
			...(record["continuityStartedAt"] === undefined
				? {}
				: { continuityStartedAt: timestamp(record["continuityStartedAt"], "continuityStartedAt") }),
			config: parseConfig(record["config"]),
		};
		return activity === undefined || activeAt === undefined ? base : { ...base, activity, activeAt };
	}
	if (type === "configure") return { type, config: parseConfig(record["config"]) };
	if (type === "activity") {
		return {
			type,
			activity: parseActivity(record["activity"]),
			activeAt: timestamp(record["activeAt"], "activeAt"),
		};
	}
	throw new CoordinatorProtocolError("Unknown coordinator client message type.");
}

export function parseServerMessage(value: unknown): CoordinatorServerMessage {
	const record = requiredRecord(value, "Coordinator server message must be an object.");
	if (record["type"] === "error") {
		return { type: "error", message: nonEmptyString(record["message"], "message", 512) };
	}
	if (record["type"] !== "status") throw new CoordinatorProtocolError("Unknown coordinator server message type.");
	const status = record["status"];
	if (status !== "disabled" && status !== "disconnected" && status !== "connecting" && status !== "connected") {
		throw new CoordinatorProtocolError("Coordinator status is invalid.");
	}
	return { type: "status", status, groupStartedAt: timestamp(record["groupStartedAt"], "groupStartedAt") };
}

function parseConfig(value: unknown): CoordinatedPresenceConfig {
	const record = requiredRecord(value, "Coordinator config must be an object.");
	const applicationId = nonEmptyString(record["applicationId"], "applicationId", 20);
	if (!APPLICATION_ID.test(applicationId)) throw new CoordinatorProtocolError("Coordinator Application ID is invalid.");
	return {
		applicationId,
		updateIntervalMs: integerInRange(record["updateIntervalMs"], "updateIntervalMs", 5_000, 60_000),
		retryIntervalMs: integerInRange(record["retryIntervalMs"], "retryIntervalMs", 5_000, 300_000),
	};
}

function parseActivity(value: unknown): DiscordActivityPayload {
	const record = requiredRecord(value, "Coordinator activity must be an object.");
	if (record["instance"] !== false) throw new CoordinatorProtocolError("Coordinator activity instance must be false.");
	return {
		...optionalStringField(record, "details"),
		...optionalStringField(record, "state"),
		...(record["startTimestamp"] === undefined
			? {}
			: { startTimestamp: timestamp(record["startTimestamp"], "startTimestamp") }),
		...optionalStringField(record, "largeImageKey"),
		...optionalStringField(record, "largeImageText"),
		...optionalStringField(record, "smallImageKey"),
		...optionalStringField(record, "smallImageText"),
		instance: false,
	};
}

function optionalStringField(record: Record<string, unknown>, key: string): Record<string, string> {
	const value = record[key];
	return value === undefined ? {} : { [key]: nonEmptyString(value, key, 256) };
}

function requiredRecord(value: unknown, message: string): Record<string, unknown> {
	if (!isRecord(value)) throw new CoordinatorProtocolError(message);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string, maximum: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
		throw new CoordinatorProtocolError(`Coordinator ${field} is invalid.`);
	}
	return value;
}

function timestamp(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new CoordinatorProtocolError(`Coordinator ${field} is invalid.`);
	}
	return value;
}

function integerInRange(value: unknown, field: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
		throw new CoordinatorProtocolError(`Coordinator ${field} is invalid.`);
	}
	return value;
}

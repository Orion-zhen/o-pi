import type { DiscordPresenceCoordinator } from "../../src/discord-presence/coordinator-client.js";
import type { CoordinatedPresenceConfig } from "../../src/discord-presence/coordinator-protocol.js";
import type {
	PresenceCoordinatorOutput,
	SelectedPresence,
} from "../../src/discord-presence/coordinator-server.js";
import { defaultDiscordPresenceConfig } from "../../src/discord-presence/config.js";
import type { DiscordPresenceTransport } from "../../src/discord-presence/transport.js";
import type {
	DiscordActivityPayload,
	DiscordPresenceConfig,
	PresenceProfileConfig,
} from "../../src/discord-presence/types.js";

export function enabledConfig(): DiscordPresenceConfig {
	const config = defaultDiscordPresenceConfig();
	config.enabled = true;
	config.application_id = "123456789012345678";
	config.profile = "detailed";
	const detailed = configuredProfile(config, "detailed");
	detailed.details.idle = "Waiting in {project}";
	detailed.details.reading = "Reading {file}";
	detailed.details.editing = "Editing {file}";
	detailed.state = "{project} · {model}";
	const minimal = configuredProfile(config, "minimal");
	minimal.details.idle = "Waiting for input";
	minimal.state = "Pi Coding Agent";
	return config;
}

export function coordinatedConfig(applicationId = "123456789012345678"): CoordinatedPresenceConfig {
	return { applicationId, updateIntervalMs: 5_000, retryIntervalMs: 30_000 };
}

export function configuredProfile(config: DiscordPresenceConfig, name: string): PresenceProfileConfig {
	const profile = config.profiles[name];
	if (profile === undefined) throw new Error(`Missing test profile: ${name}`);
	return profile;
}

export class FakeCoordinator implements DiscordPresenceCoordinator {
	readonly activities: DiscordActivityPayload[] = [];
	readonly activations: Array<{
		config: CoordinatedPresenceConfig;
		joinedAt: number;
		activity?: DiscordActivityPayload;
	}> = [];
	deactivateCount = 0;
	status: ReturnType<DiscordPresenceCoordinator["getStatus"]> = "disabled";
	private readonly listeners = new Set<(status: ReturnType<DiscordPresenceCoordinator["getStatus"]>) => void>();

	async activate(
		config: CoordinatedPresenceConfig,
		joinedAt: number,
		activity?: DiscordActivityPayload,
	): Promise<void> {
		this.activations.push({ config, joinedAt, ...(activity === undefined ? {} : { activity }) });
		if (activity !== undefined) this.activities.push(activity);
		this.status = "connected";
	}
	request(activity: DiscordActivityPayload): void {
		this.activities.push(activity);
	}
	async deactivate(): Promise<void> {
		this.deactivateCount += 1;
		this.status = "disabled";
	}
	getStatus() {
		return this.status;
	}
	onStatus(listener: (status: ReturnType<DiscordPresenceCoordinator["getStatus"]>) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

export class FakeCoordinatorOutput implements PresenceCoordinatorOutput {
	readonly selections: SelectedPresence[] = [];
	hideCount = 0;
	clearCount = 0;
	status: ReturnType<PresenceCoordinatorOutput["getStatus"]> = "connected";
	private readonly listeners = new Set<(status: ReturnType<PresenceCoordinatorOutput["getStatus"]>) => void>();

	show(selection: SelectedPresence): void {
		this.selections.push(selection);
	}
	async hide(): Promise<void> {
		this.hideCount += 1;
	}
	async clear(): Promise<void> {
		this.clearCount += 1;
	}
	getStatus() {
		return this.status;
	}
	onStatus(listener: (status: ReturnType<PresenceCoordinatorOutput["getStatus"]>) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

export class FakeTransport implements DiscordPresenceTransport {
	readonly activities: DiscordActivityPayload[] = [];
	clearCount = 0;
	closeCount = 0;
	failSetCount = 0;
	status: ReturnType<DiscordPresenceTransport["getStatus"]> = "disconnected";
	private readonly listeners = new Set<(status: ReturnType<DiscordPresenceTransport["getStatus"]>) => void>();

	async setActivity(activity: DiscordActivityPayload): Promise<void> {
		if (this.failSetCount > 0) {
			this.failSetCount -= 1;
			this.status = "disconnected";
			throw new Error("Discord unavailable");
		}
		this.status = "connected";
		this.activities.push(activity);
	}
	async clearActivity(): Promise<void> {
		this.clearCount += 1;
	}
	async close(): Promise<void> {
		this.status = "disabled";
		this.closeCount += 1;
	}
	getStatus() {
		return this.status;
	}
	onStatus(listener: (status: ReturnType<DiscordPresenceTransport["getStatus"]>) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	emitStatus(status: ReturnType<DiscordPresenceTransport["getStatus"]>): void {
		this.status = status;
		for (const listener of this.listeners) listener(status);
	}
}

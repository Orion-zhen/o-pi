import type { CoordinatedPresenceConfig } from "../../../src/harness/discord-presence/coordinator-protocol.js";
import type { DiscordCoordinatorOutput } from "../../../src/harness/discord-presence/output.js";
import { agentSchemaPath, defaultAgentConfigPath, readDefaultJsoncConfigSync } from "../../../src/harness/config-loader.js";
import type { DiscordPresenceTransport } from "../../../src/harness/discord-presence/transport.js";
import type { DiscordActivityPayload, DiscordPresenceConfig, PresenceProfileConfig, PresenceConnectionStatus } from "../../../src/harness/discord-presence/types.js";

export function enabledConfig(): DiscordPresenceConfig {
	const config = readDefaultJsoncConfigSync({
		configPath: defaultAgentConfigPath("discord-presence.jsonc"),
		schemaPath: agentSchemaPath("discord-presence.schema.json"),
		label: "discord-presence", createError: (message) => new Error(message),
	}) as DiscordPresenceConfig;
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

export class FakeCoordinator {
	readonly activities: DiscordActivityPayload[] = [];
	readonly activations: Array<{ config: CoordinatedPresenceConfig; joinedAt: number; activity?: DiscordActivityPayload }> = [];
	deactivateCount = 0;
	status: PresenceConnectionStatus = "disabled";
	async activate(config: CoordinatedPresenceConfig, joinedAt: number, activity?: DiscordActivityPayload): Promise<void> {
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
	getStatus() { return this.status; }
}

export class FakeCoordinatorOutput {
	readonly selections: Array<Parameters<DiscordCoordinatorOutput["show"]>[0]> = [];
	hideCount = 0;
	disposeCount = 0;
	show(selection: Parameters<DiscordCoordinatorOutput["show"]>[0]): void { this.selections.push(selection); }
	async hide(): Promise<void> { this.hideCount += 1; }
	async dispose(): Promise<void> { this.disposeCount += 1; }
	getStatus(): PresenceConnectionStatus { return "connected"; }
	onStatus(): () => void { return () => {}; }
}

export class FakeTransport implements DiscordPresenceTransport {
	readonly activities: DiscordActivityPayload[] = [];
	clearCount = 0;
	closeCount = 0;
	failSetCount = 0;
	status: PresenceConnectionStatus = "disconnected";
	private readonly listeners = new Set<(status: PresenceConnectionStatus) => void>();

	async setActivity(activity: DiscordActivityPayload): Promise<void> {
		if (this.failSetCount > 0) {
			this.failSetCount -= 1;
			this.status = "disconnected";
			throw new Error("Discord unavailable");
		}
		this.status = "connected";
		this.activities.push(activity);
	}
	async clearActivity(): Promise<void> { this.clearCount += 1; }
	async close(): Promise<void> {
		this.status = "disabled";
		this.closeCount += 1;
	}
	getStatus() { return this.status; }
	onStatus(listener: (status: PresenceConnectionStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	emitStatus(status: PresenceConnectionStatus): void {
		this.status = status;
		for (const listener of this.listeners) listener(status);
	}
}

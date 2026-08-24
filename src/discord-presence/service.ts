import path from "node:path";
import { performance } from "node:perf_hooks";
import {
	currentActivity,
	endTool,
	initialPresenceActivityState,
	settleAgent,
	startTool,
	startTurn,
	updateTool,
	type PresenceActivityState,
} from "./activity.js";
import { loadDiscordPresenceConfig } from "./config.js";
import {
	DiscordPresenceCoordinatorClient,
	type DiscordPresenceCoordinator,
} from "./coordinator-client.js";
import { renderDiscordActivity } from "./render.js";
import type {
	DiscordActivityPayload,
	DiscordPresenceConfig,
	PresenceConnectionStatus,
	PresenceProfileName,
	PresenceSession,
} from "./types.js";

export interface PresenceStartContext {
	cwd: string;
	model: { id: string; name: string } | undefined;
	sessionName: string | undefined;
	idle: boolean;
}

export interface PresenceStatusSnapshot {
	enabled: boolean;
	profile: PresenceProfileName | undefined;
	connection: PresenceConnectionStatus;
}

export interface DiscordPresenceServiceOptions {
	loadConfig?: (cwd: string) => Promise<DiscordPresenceConfig>;
	coordinator?: DiscordPresenceCoordinator;
	processStartedAt?: number;
}

interface LoadedPresenceState {
	config: DiscordPresenceConfig;
	session: PresenceSession;
}

/** 管理 Presence 状态；所有 session 沿用当前 Pi 进程的计时起点。 */
export class DiscordPresenceService {
	private loaded: LoadedPresenceState | undefined;
	private activity: PresenceActivityState = initialPresenceActivityState();
	private readonly coordinator: DiscordPresenceCoordinator;
	private coordinatorActive = false;
	private runtimeEnabled: boolean | undefined;
	private runtimeProfile: PresenceProfileName | undefined;
	private generation = 0;
	private readonly loadConfig: (cwd: string) => Promise<DiscordPresenceConfig>;
	private readonly processStartedAt: number;

	constructor(options: DiscordPresenceServiceOptions = {}) {
		this.loadConfig = options.loadConfig ?? loadDiscordPresenceConfig;
		this.coordinator = options.coordinator ?? new DiscordPresenceCoordinatorClient();
		this.processStartedAt = options.processStartedAt ?? Math.floor(performance.timeOrigin);
	}

	async startSession(context: PresenceStartContext): Promise<void> {
		this.runtimeEnabled = undefined;
		this.runtimeProfile = undefined;
		await this.activate(context);
	}

	async reload(context: PresenceStartContext): Promise<void> {
		await this.activate(context);
	}

	async enable(context: PresenceStartContext): Promise<void> {
		this.runtimeEnabled = true;
		await this.activate(context);
	}

	async disable(): Promise<void> {
		this.runtimeEnabled = false;
		this.generation += 1;
		await this.disposeActive();
	}

	async shutdown(): Promise<void> {
		this.generation += 1;
		await this.disposeActive();
		this.loaded = undefined;
	}

	selectProfile(profile: PresenceProfileName): void {
		const config = this.loaded?.config;
		if (config === undefined || !Object.hasOwn(config.profiles, profile)) {
			throw new Error(`Unknown Discord presence profile: ${profile}`);
		}
		this.runtimeProfile = profile;
		this.publish();
	}

	profileNames(): string[] {
		return this.loaded === undefined ? [] : Object.keys(this.loaded.config.profiles);
	}

	status(): PresenceStatusSnapshot {
		return {
			enabled: this.coordinatorActive,
			profile: this.loaded === undefined ? undefined : this.activeProfileName(this.loaded.config),
			connection: this.coordinatorActive ? this.coordinator.getStatus() : "disabled",
		};
	}

	onTurnStart(): void {
		this.activity = startTurn(this.activity);
		this.publish();
	}

	onToolStart(toolCallId: string, toolName: string, args: unknown): void {
		this.activity = startTool(this.activity, toolCallId, toolName, args);
		this.publish();
	}

	onToolStreamUpdate(
		previousToolCallId: string,
		toolCallId: string,
		toolName: string,
		args: unknown,
	): void {
		this.activity = updateTool(this.activity, previousToolCallId, toolCallId, toolName, args);
		this.publish();
	}

	onToolEnd(toolCallId: string): void {
		this.activity = endTool(this.activity, toolCallId);
		this.publish();
	}

	onAgentSettled(): void {
		this.activity = settleAgent();
		this.publish();
	}

	onModelSelect(model: { id: string; name: string }): void {
		if (this.loaded !== undefined) {
			this.loaded = {
				...this.loaded,
				session: { ...this.loaded.session, model: modelDisplayName(model) },
			};
		}
		this.publish();
	}

	onSessionName(name: string | undefined): void {
		if (this.loaded !== undefined) {
			this.loaded = {
				...this.loaded,
				session: { ...this.loaded.session, session: name ?? this.loaded.session.project },
			};
		}
		this.publish();
	}

	private async activate(context: PresenceStartContext): Promise<void> {
		const generation = ++this.generation;
		const config = await this.loadConfig(context.cwd);
		if (generation !== this.generation) return;
		if (this.runtimeProfile !== undefined && !Object.hasOwn(config.profiles, this.runtimeProfile)) {
			this.runtimeProfile = undefined;
		}
		this.activity = context.idle ? initialPresenceActivityState() : startTurn(initialPresenceActivityState());
		const project = path.basename(context.cwd) || context.cwd;
		const session: PresenceSession = {
			project,
			model: context.model === undefined ? "No model" : modelDisplayName(context.model),
			session: context.sessionName ?? project,
			startedAt: this.processStartedAt,
		};
		this.loaded = { config, session };
		if (!(this.runtimeEnabled ?? config.enabled)) {
			await this.disposeActive();
			return;
		}
		if (config.application_id.length === 0) {
			throw new Error("application_id is required to enable Discord presence.");
		}
		const initialActivity = this.renderActivity(this.loaded);
		this.coordinatorActive = true;
		try {
			await this.coordinator.activate({
				applicationId: config.application_id,
				updateIntervalMs: config.update_interval_ms,
				retryIntervalMs: config.retry_interval_ms,
			}, session.startedAt, initialActivity);
		} catch (error) {
			if (generation === this.generation) {
				this.coordinatorActive = false;
				await this.coordinator.deactivate().catch(() => undefined);
			}
			throw error;
		}
	}

	private renderActivity(state: LoadedPresenceState): DiscordActivityPayload | undefined {
		const profileName = this.activeProfileName(state.config);
		const profile = state.config.profiles[profileName];
		if (profile === undefined) throw new Error(`Unknown Discord presence profile: ${profileName}`);
		return renderDiscordActivity(
			state.config,
			profile,
			currentActivity(this.activity),
			state.session,
		);
	}

	private async disposeActive(): Promise<void> {
		if (!this.coordinatorActive) return;
		this.coordinatorActive = false;
		await this.coordinator.deactivate();
	}

	private publish(): void {
		if (!this.coordinatorActive) return;
		if (this.loaded === undefined) throw new Error("Discord presence is active without a loaded session.");
		const rendered = this.renderActivity(this.loaded);
		if (rendered !== undefined) this.coordinator.request(rendered);
	}

	private activeProfileName(config: DiscordPresenceConfig): PresenceProfileName {
		return this.runtimeProfile ?? config.profile;
	}
}

function modelDisplayName(model: { id: string; name: string }): string {
	const value = model.name || model.id;
	return value.split("/").at(-1) || value;
}

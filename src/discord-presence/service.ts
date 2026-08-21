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
import {
	PRESENCE_PROFILES,
	type DiscordActivityPayload,
	type DiscordPresenceConfig,
	type PresenceConnectionStatus,
	type PresenceProfileName,
	type PresenceSession,
} from "./types.js";

export interface PresenceStartContext {
	cwd: string;
	model: { id: string; name: string } | undefined;
	sessionName: string | undefined;
	idle: boolean;
}

export interface PresenceStatusSnapshot {
	enabled: boolean;
	profile: PresenceProfileName;
	connection: PresenceConnectionStatus;
}

export interface DiscordPresenceServiceOptions {
	loadConfig?: (cwd: string) => Promise<DiscordPresenceConfig>;
	coordinator?: DiscordPresenceCoordinator;
	processStartedAt?: number;
}

/** 管理 Presence 状态；所有 session 沿用当前 Pi 进程的计时起点。 */
export class DiscordPresenceService {
	private config: DiscordPresenceConfig | undefined;
	private session: PresenceSession | undefined;
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
		this.config = undefined;
		this.session = undefined;
	}

	selectProfile(profile: PresenceProfileName): void {
		if (this.config === undefined || !Object.hasOwn(this.config.profiles, profile)) {
			throw new Error(`Unknown Discord presence profile: ${profile}`);
		}
		this.runtimeProfile = profile;
		this.publish();
	}

	profileNames(): string[] {
		return this.config === undefined ? [...PRESENCE_PROFILES] : Object.keys(this.config.profiles);
	}

	status(): PresenceStatusSnapshot {
		return {
			enabled: this.coordinatorActive,
			profile: this.activeProfile(),
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
		if (this.session !== undefined) this.session = { ...this.session, model: modelDisplayName(model) };
		this.publish();
	}

	onSessionName(name: string | undefined): void {
		if (this.session !== undefined) this.session = { ...this.session, session: name || this.session.project };
		this.publish();
	}

	private async activate(context: PresenceStartContext): Promise<void> {
		const generation = ++this.generation;
		const config = await this.loadConfig(context.cwd);
		if (generation !== this.generation) return;
		this.config = config;
		if (this.runtimeProfile !== undefined && !Object.hasOwn(config.profiles, this.runtimeProfile)) {
			this.runtimeProfile = undefined;
		}
		this.activity = context.idle ? initialPresenceActivityState() : startTurn(initialPresenceActivityState());
		this.session = {
			project: path.basename(context.cwd) || context.cwd,
			model: context.model === undefined ? "No model" : modelDisplayName(context.model),
			session: context.sessionName || path.basename(context.cwd) || context.cwd,
			startedAt: this.processStartedAt,
		};
		if (!(this.runtimeEnabled ?? config.enabled)) {
			await this.disposeActive();
			return;
		}
		if (config.application_id.length === 0) {
			throw new Error("application_id is required to enable Discord presence.");
		}
		const initialActivity = this.renderActivity();
		this.coordinatorActive = true;
		try {
			await this.coordinator.activate({
				applicationId: config.application_id,
				updateIntervalMs: config.update_interval_ms,
				retryIntervalMs: config.retry_interval_ms,
			}, this.session.startedAt, initialActivity);
		} catch (error) {
			if (generation === this.generation) {
				this.coordinatorActive = false;
				await this.coordinator.deactivate().catch(() => undefined);
			}
			throw error;
		}
	}

	private renderActivity(): DiscordActivityPayload | undefined {
		if (this.config === undefined || this.session === undefined) return undefined;
		return renderDiscordActivity(
			this.config,
			this.activeProfile(),
			currentActivity(this.activity),
			this.session,
		);
	}

	private async disposeActive(): Promise<void> {
		if (!this.coordinatorActive) return;
		this.coordinatorActive = false;
		await this.coordinator.deactivate().catch(() => undefined);
	}

	private publish(): void {
		if (!this.coordinatorActive || this.config === undefined || this.session === undefined) return;
		const rendered = this.renderActivity();
		if (rendered !== undefined) this.coordinator.request(rendered);
	}

	private activeProfile(): PresenceProfileName {
		return this.runtimeProfile ?? this.config?.profile ?? PRESENCE_PROFILES[2];
	}
}

function modelDisplayName(model: { id: string; name: string }): string {
	const value = model.name || model.id;
	return value.split("/").at(-1) || value;
}

import path from "node:path";
import { performance } from "node:perf_hooks";
import { PresenceActivityTracker, type ToolStreamEvent } from "./activity-tracker.ts";
import { loadDiscordPresenceConfig } from "./config.ts";
import { DiscordPresenceCoordinatorClient } from "./coordinator-client.ts";
import { renderDiscordActivity } from "./render.ts";
import type {
	DiscordActivityPayload,
	DiscordPresenceConfig,
	PresenceConnectionStatus,
	PresenceSession,
	PresenceProfileConfig,
} from "./types.ts";

export interface PresenceStartContext {
	cwd: string;
	model: { id: string; name: string } | undefined;
	sessionName: string | undefined;
	idle: boolean;
}

interface PresenceStatusSnapshot {
	enabled: boolean;
	profile: string | undefined;
	connection: PresenceConnectionStatus;
}

interface SelectedPresenceProfile {
	name: string;
	config: PresenceProfileConfig;
}

interface LoadedPresenceState {
	config: DiscordPresenceConfig;
	session: PresenceSession;
	profile: SelectedPresenceProfile;
}

type PresenceState =
	| { kind: "unloaded" }
	| { kind: "inactive" | "active"; loaded: LoadedPresenceState };

/** 管理 Presence 状态；所有 session 沿用当前 Pi 进程的计时起点。 */
export class DiscordPresenceService {
	private state: PresenceState = { kind: "unloaded" };
	private readonly activity = new PresenceActivityTracker();
	private readonly coordinator = new DiscordPresenceCoordinatorClient();
	private runtimeEnabled: boolean | undefined;
	private runtimeProfile: string | undefined;
	private generation = 0;
	private readonly processStartedAt = Math.floor(performance.timeOrigin);

	async startSession(context: PresenceStartContext): Promise<void> {
		this.runtimeEnabled = undefined;
		this.runtimeProfile = undefined;
		this.activity.clear();
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
		this.activity.clear();
		await this.disposeActive();
		this.state = { kind: "unloaded" };
	}

	selectProfile(profile: string): void {
		if (this.state.kind === "unloaded") throw new Error(`Unknown Discord presence profile: ${profile}`);
		this.state.loaded.profile = selectProfile(this.state.loaded.config, profile);
		this.runtimeProfile = profile;
		this.publish();
	}

	profileNames(): string[] {
		return this.state.kind === "unloaded" ? [] : Object.keys(this.state.loaded.config.profiles);
	}

	status(): PresenceStatusSnapshot {
		const active = this.state.kind === "active";
		return {
			enabled: active,
			profile: this.state.kind === "unloaded" ? undefined : this.state.loaded.profile.name,
			connection: active ? this.coordinator.getStatus() : "disabled",
		};
	}

	onTurnStart(): void {
		this.activity.startTurn();
		this.publish();
	}

	onToolStart(toolCallId: string, toolName: string, args: unknown): void {
		this.activity.startTool(toolCallId, toolName, args);
		this.publish();
	}

	onToolStream(event: ToolStreamEvent): void {
		if (this.activity.stream(event)) this.publish();
	}

	onMessageAbort(messageKey: string): void {
		this.activity.abortMessage(messageKey);
		this.publish();
	}

	onToolEnd(toolCallId: string): void {
		this.activity.endTool(toolCallId);
		this.publish();
	}

	onAgentSettled(): void {
		this.activity.clear();
		this.publish();
	}

	onModelSelect(model: { id: string; name: string }): void {
		if (this.state.kind !== "unloaded") this.state.loaded.session.model = modelDisplayName(model);
		this.publish();
	}

	onSessionName(name: string | undefined): void {
		if (this.state.kind !== "unloaded") {
			this.state.loaded.session.session = name ?? this.state.loaded.session.project;
		}
		this.publish();
	}

	private async activate(context: PresenceStartContext): Promise<void> {
		const generation = ++this.generation;
		const config = await loadDiscordPresenceConfig(context.cwd);
		if (generation !== this.generation) return;
		if (this.runtimeProfile !== undefined && !Object.hasOwn(config.profiles, this.runtimeProfile)) {
			this.runtimeProfile = undefined;
		}
		if (!context.idle) this.activity.startTurn();
		const project = path.basename(context.cwd) || context.cwd;
		const session: PresenceSession = {
			project,
			model: context.model === undefined ? "No model" : modelDisplayName(context.model),
			session: context.sessionName ?? project,
			startedAt: this.processStartedAt,
		};
		const loaded = { config, session, profile: selectProfile(config, this.runtimeProfile ?? config.profile) };
		this.state = { kind: this.state.kind === "active" ? "active" : "inactive", loaded };
		if (!(this.runtimeEnabled ?? config.enabled)) {
			await this.disposeActive();
			return;
		}
		if (config.application_id.length === 0) {
			throw new Error("application_id is required to enable Discord presence.");
		}
		const initialActivity = this.renderActivity(loaded);
		this.state = { kind: "active", loaded };
		try {
			await this.coordinator.activate({
				applicationId: config.application_id,
				updateIntervalMs: config.update_interval_ms,
				retryIntervalMs: config.retry_interval_ms,
			}, session.startedAt, initialActivity);
		} catch (error) {
			if (generation === this.generation) {
				this.state = { kind: "inactive", loaded };
				await this.coordinator.deactivate().catch(() => undefined);
			}
			throw error;
		}
	}

	private renderActivity(state: LoadedPresenceState): DiscordActivityPayload | undefined {
		return renderDiscordActivity(
			state.config,
			state.profile.config,
			this.activity.current(),
			state.session,
		);
	}

	private async disposeActive(): Promise<void> {
		if (this.state.kind !== "active") return;
		this.state = { kind: "inactive", loaded: this.state.loaded };
		await this.coordinator.deactivate();
	}

	private publish(): void {
		if (this.state.kind !== "active") return;
		const rendered = this.renderActivity(this.state.loaded);
		if (rendered !== undefined) this.coordinator.request(rendered);
	}
}

function selectProfile(config: DiscordPresenceConfig, name: string): SelectedPresenceProfile {
	const profile = Object.hasOwn(config.profiles, name) ? config.profiles[name] : undefined;
	if (profile === undefined) throw new Error(`Unknown Discord presence profile: ${name}`);
	return { name, config: profile };
}

function modelDisplayName(model: { id: string; name: string }): string {
	const value = model.name || model.id;
	return value.split("/").at(-1) || value;
}

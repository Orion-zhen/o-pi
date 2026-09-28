import type { AgentSession, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { StatsSnapshot } from "../../harness/stats/types.ts";
import type { LiveTelemetryReport } from "../../harness/telemetry-report/live.ts";
import type { GuiEvent } from "../contract.ts";

type ReportSource = { session: AgentSession; entry: SessionEntry | undefined; idle: boolean };

/** 统计依赖历史和运行状态，遥测还依赖在途工具数。树直接来自历史条目。 */
export class GuiReports {
	private readStats: ((ctx: ExtensionCommandContext) => Promise<StatsSnapshot>) | undefined;
	private readTelemetry: (() => LiveTelemetryReport) | undefined;
	private stats: Extract<GuiEvent, { type: "sessionStats" }> | undefined;
	private telemetry: Extract<GuiEvent, { type: "telemetry" }> | undefined;
	private source: ReportSource | undefined;
	private tools = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private pending: Promise<void> | undefined;
	private statsDirty = false;
	private telemetryDirty = false;

	constructor(private publish: (event: GuiEvent) => void, private reportError: (error: unknown) => void) {}
	bindStats(read: (ctx: ExtensionCommandContext) => Promise<StatsSnapshot>): void { this.readStats = read; this.invalidate(); }
	bindTelemetry(read: () => LiveTelemetryReport): void { this.readTelemetry = read; this.invalidate(); }

	replay(listener: (event: GuiEvent) => void): void {
		if (this.stats) listener(this.stats);
		if (this.telemetry) listener(this.telemetry);
	}
	schedule(session: AgentSession, tools: number): void {
		const entry = session.sessionManager.getEntry(session.sessionManager.getLeafId() ?? "");
		const idle = session.isIdle;
		if (this.source?.session !== session || this.source.entry !== entry || this.source.idle !== idle) {
			this.source = { session, entry, idle };
			this.statsDirty = this.telemetryDirty = true;
		}
		if (tools !== this.tools) { this.tools = tools; this.telemetryDirty = true; }
		this.enqueue();
	}
	private enqueue(): void {
		if (this.pending || this.timer || !this.statsDirty && !this.telemetryDirty) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.source) this.pending = this.load(this.source).finally(() => { this.pending = undefined; this.enqueue(); });
		}, 150);
	}
	private async load(source: ReportSource): Promise<void> {
		const statsDirty = this.statsDirty;
		const telemetryDirty = this.telemetryDirty;
		this.statsDirty = this.telemetryDirty = false;
		const sessionId = source.session.sessionId;
		if (telemetryDirty && this.readTelemetry) {
			try {
				this.telemetry = { type: "telemetry", sessionId, value: this.readTelemetry() };
				this.publish(this.telemetry);
			} catch (error) { this.reportError(error); }
		}
		if (statsDirty && this.readStats) {
			try {
				const value = await this.readStats(source.session.extensionRunner.createCommandContext());
				if (this.source === source) { this.stats = { type: "sessionStats", sessionId, value }; this.publish(this.stats); }
			} catch (error) { if (this.source === source) this.reportError(error); }
		}
	}
	invalidate(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.source = undefined;
		this.stats = undefined;
		this.telemetry = undefined;
		this.statsDirty = this.telemetryDirty = false;
	}
	async dispose(): Promise<void> { this.invalidate(); await this.pending; }
}

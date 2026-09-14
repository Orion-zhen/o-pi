import { OPetClient, type OPetClientOptions, type OPetEventClient } from "./client.js";
import type { OPetOutcome } from "./protocol.js";

export interface OPetServiceOptions extends OPetClientOptions {
	client?: OPetEventClient;
	now?: () => number;
}

const TOOL_PROGRESS_INTERVAL_MS = 1_500;

export class OPetService {
	private readonly client: OPetEventClient;
	private readonly now: () => number;
	private outcome: OPetOutcome = "success";
	private runStartedAt: number | undefined;
	private readonly toolProgressAt = new Map<string, number>();

	constructor(options: OPetServiceOptions = {}) {
		this.client = options.client ?? new OPetClient(options);
		this.now = options.now ?? Date.now;
	}

	startSession(sessionId: string): void {
		this.client.startSession(sessionId);
	}

	onAgentStart(): void {
		this.outcome = "success";
		this.runStartedAt = this.now();
		this.toolProgressAt.clear();
		this.client.publish({ type: "agent_started" });
	}

	onTurnStart(): void {
		this.client.publish({ type: "turn_started" });
	}

	onThinkingStart(): void {
		this.client.publish({ type: "thinking_started" });
	}

	onReplyStart(): void {
		this.client.publish({ type: "reply_started" });
	}

	onReplyEnd(): void {
		this.client.publish({ type: "reply_finished" });
	}

	onMessageEnd(stopReason: "error" | "aborted"): void {
		this.outcome = stopReason;
	}

	onToolObserved(toolName: string): void {
		this.client.publish({ type: "tool_observed", toolName });
	}

	onToolStart(toolCallId: string, toolName: string): void {
		this.toolProgressAt.delete(toolCallId);
		this.client.publish({ type: "tool_started", toolCallId, toolName });
	}

	onToolProgress(toolCallId: string): void {
		const now = this.now();
		const previous = this.toolProgressAt.get(toolCallId);
		if (previous !== undefined && now - previous < TOOL_PROGRESS_INTERVAL_MS) return;
		this.toolProgressAt.set(toolCallId, now);
		this.client.publish({ type: "tool_progressed", toolCallId });
	}

	onToolEnd(toolCallId: string, isError: boolean): void {
		this.toolProgressAt.delete(toolCallId);
		this.client.publish({
			type: "tool_finished",
			toolCallId,
			outcome: isError ? "error" : "success",
		});
	}

	onApprovalRequested(toolCallId: string, toolName: string): void {
		this.client.publish({ type: "approval_requested", toolCallId, toolName });
	}

	onApprovalResolved(toolCallId: string, outcome: "approved" | "denied"): void {
		this.client.publish({ type: "approval_resolved", toolCallId, outcome });
	}

	onAgentSettled(): void {
		const startedAt = this.runStartedAt ?? this.now();
		const durationMs = Math.max(0, Math.round(this.now() - startedAt));
		this.client.publish({ type: "agent_settled", outcome: this.outcome, durationMs });
		this.runStartedAt = undefined;
		this.toolProgressAt.clear();
	}

	shutdown(): void {
		this.toolProgressAt.clear();
		this.client.shutdown();
	}
}

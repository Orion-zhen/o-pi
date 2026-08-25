import type { ToolCall } from "@earendil-works/pi-ai";
import type {
	AgentSettledEvent,
	AgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	MessageUpdateEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { APPROVAL_STATUS_CHANNEL, type ApprovalStatusEvent } from "../../src/approval/events.js";
import { OPetService, type OPetServiceOptions } from "../../src/o-pet/service.js";
import { OPetStreamingToolTracker } from "../../src/o-pet/streaming.js";

export interface OPetEventHandlers {
	sessionStart(
		event: SessionStartEvent,
		ctx: { sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId"> },
	): void;
	agentStart(event: AgentStartEvent): void;
	turnStart(event: TurnStartEvent): void;
	messageUpdate(event: MessageUpdateEvent): void;
	messageEnd(event: MessageEndEvent): void;
	toolExecutionStart(event: ToolExecutionStartEvent): void;
	toolExecutionUpdate(event: ToolExecutionUpdateEvent): void;
	toolExecutionEnd(event: ToolExecutionEndEvent): void;
	approvalStatus(event: ApprovalStatusEvent): void;
	agentSettled(event: AgentSettledEvent): void;
	sessionShutdown(event: SessionShutdownEvent): void;
}

export function createOPetExtension(options: OPetServiceOptions = {}): (pi: ExtensionAPI) => void {
	return function oPetExtension(pi: ExtensionAPI): void {
		const handlers = createOPetEventHandlers(new OPetService(options));
		pi.on("session_start", handlers.sessionStart);
		pi.on("agent_start", handlers.agentStart);
		pi.on("turn_start", handlers.turnStart);
		pi.on("message_update", handlers.messageUpdate);
		pi.on("message_end", handlers.messageEnd);
		pi.on("tool_execution_start", handlers.toolExecutionStart);
		pi.on("tool_execution_update", handlers.toolExecutionUpdate);
		pi.on("tool_execution_end", handlers.toolExecutionEnd);
		pi.events.on(APPROVAL_STATUS_CHANNEL, (event) => handlers.approvalStatus(event as ApprovalStatusEvent));
		pi.on("agent_settled", handlers.agentSettled);
		pi.on("session_shutdown", handlers.sessionShutdown);
	};
}

export function createOPetEventHandlers(service: OPetService): OPetEventHandlers {
	const streamingTools = new OPetStreamingToolTracker();
	return {
		sessionStart(_event, ctx) {
			service.startSession(ctx.sessionManager.getSessionId());
		},
		agentStart() {
			service.onAgentStart();
		},
		turnStart() {
			service.onTurnStart();
		},
		messageUpdate(event) {
			const streamEvent = event.assistantMessageEvent;
			if (streamEvent.type === "thinking_start") {
				service.onThinkingStart();
				return;
			}
			if (streamEvent.type === "text_start") {
				service.onReplyStart();
				return;
			}
			if (
				streamEvent.type !== "toolcall_start"
				&& streamEvent.type !== "toolcall_delta"
				&& streamEvent.type !== "toolcall_end"
			) return;
			let call: ToolCall;
			if (streamEvent.type === "toolcall_end") {
				call = streamEvent.toolCall;
			} else {
				const partialCall = streamEvent.partial.content[streamEvent.contentIndex];
				if (partialCall?.type !== "toolCall") {
					throw new Error("o-pet received an invalid tool stream event.");
				}
				call = partialCall;
			}
			const toolName = streamingTools.update(event.message.timestamp, streamEvent.contentIndex, call);
			if (toolName !== undefined) service.onToolObserved(toolName);
		},
		messageEnd(event) {
			if (event.message.role !== "assistant") return;
			if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
				service.onMessageEnd(event.message.stopReason);
			} else if (event.message.stopReason === "stop" || event.message.stopReason === "length") {
				service.onReplyEnd();
			}
		},
		toolExecutionStart(event) {
			service.onToolStart(event.toolCallId, event.toolName);
		},
		toolExecutionUpdate(event) {
			service.onToolProgress(event.toolCallId);
		},
		toolExecutionEnd(event) {
			service.onToolEnd(event.toolCallId, event.isError);
		},
		approvalStatus(event) {
			if (event.type === "requested") service.onApprovalRequested(event.toolCallId, event.toolName);
			else service.onApprovalResolved(event.toolCallId, event.outcome);
		},
		agentSettled() {
			streamingTools.clear();
			service.onAgentSettled();
		},
		sessionShutdown() {
			service.shutdown();
		},
	};
}

export default createOPetExtension();

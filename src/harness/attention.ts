import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { APPROVAL_STATUS_CHANNEL, type ApprovalStatusEvent } from "./approval/events.ts";

export type Attention = {
	sessionId: string;
	name: string | undefined;
	firstMessage: string;
} & ({ kind: "approval"; toolName: string } | { kind: "completed" });

/** 只投递业务事实，不依赖窗口、终端或系统通知。 */
export function registerAttention(pi: ExtensionAPI, receive: (event: Attention) => void): void {
	let unsubscribe: (() => void) | undefined;
	const emit = (ctx: ExtensionContext, event: { kind: "completed" } | { kind: "approval"; toolName: string }) => {
		const first = ctx.sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user");
		const content = first?.type === "message" && first.message.role === "user" ? first.message.content : "";
		receive({ ...event, sessionId: ctx.sessionManager.getSessionId(), name: ctx.sessionManager.getSessionName(),
			firstMessage: typeof content === "string" ? content : content.filter((block) => block.type === "text").map((block) => block.text).join(" ") });
	};
	pi.on("session_start", (_event, ctx) => {
		unsubscribe?.();
		unsubscribe = pi.events.on(APPROVAL_STATUS_CHANNEL, (data) => {
			const event = data as ApprovalStatusEvent;
			if (event.type === "requested") emit(ctx, { kind: "approval", toolName: event.toolName });
		});
	});
	pi.on("agent_settled", (event, ctx) => {
		if (event.aborted) return;
		const last = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (last?.type === "message" && last.message.role === "assistant" && ["error", "aborted"].includes(last.message.stopReason)) return;
		emit(ctx, { kind: "completed" });
	});
	pi.on("session_shutdown", () => { unsubscribe?.(); unsubscribe = undefined; });
}

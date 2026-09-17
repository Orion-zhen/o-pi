import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifyWaiting } from "../../harness/notification/native.ts";
import { clearChrome } from "./chrome.ts";
import { loadTuiConfig } from "./config.ts";
import { MathInitialization } from "../chat/math/initialization.ts";
import { createAssistantPerformanceTracker } from "../chat/message-performance.ts";
import { recordUserMessageTimestamp, resetUserMessageTimestamps } from "../chat/message-timestamp.ts";
import { TuiSession } from "./session.ts";
import { collectUserMessages } from "./snapshot.ts";
import { UserHistoryStore } from "../../harness/user-history.ts";

export interface TuiRuntime {
	startSession(ctx: ExtensionContext, replaySessionMessages: boolean): Promise<void>;
	dispose(): Promise<void>;
}

/** 原生 TUI 入口只协调事件，资源分别由活动会话和数学初始化器持有。 */
export function createTuiRuntime(pi: ExtensionAPI): TuiRuntime {
	let session: TuiSession | undefined;
	let sessionGeneration = 0;
	const math = new MathInitialization();
	const assistantPerformance = createAssistantPerformanceTracker();
	const userHistory = new UserHistoryStore();

	pi.on("agent_start", () => {
		math.cancel();
		session?.refresh("running");
		session?.leaveHome();
	});
	pi.on("turn_end", () => session?.refresh("running"));
	pi.on("ui_prompt_start", () => {
		if (session?.status === "running") session.refresh("waiting");
	});
	pi.on("ui_prompt_end", () => {
		if (session?.status === "waiting") session.refresh("running");
	});
	pi.on("agent_settled", async (_event, ctx) => {
		session?.refresh("ready");
		math.schedule();
		if (ctx.mode !== "tui") return;
		await notifyWaiting();
	});

	pi.on("before_provider_headers", () => {
		if (session !== undefined) assistantPerformance.startRequest();
	});
	pi.on("message_start", (event) => {
		if (session === undefined) return;
		if (event.message.role === "user") recordUserMessageTimestamp(event.message);
		else if (event.message.role === "assistant") assistantPerformance.startMessage(event.message);
	});
	pi.on("message_update", (event) => {
		if (session !== undefined && event.message.role === "assistant") {
			assistantPerformance.updateMessage(event.message, event.assistantMessageEvent);
		}
	});
	pi.on("message_end", (event) => {
		if (session !== undefined && event.message.role === "assistant") assistantPerformance.endMessage(event.message);
	});
	pi.on("session_compact", (_event, ctx) => {
		if (session !== undefined) resetUserMessageTimestamps(collectUserMessages(ctx));
	});
	pi.on("session_tree", (_event, ctx) => {
		if (session !== undefined) resetUserMessageTimestamps(collectUserMessages(ctx));
	});
	pi.on("session_info_changed", () => session?.refresh());
	pi.on("model_select", () => session?.refresh());
	pi.on("thinking_level_select", () => session?.refresh());
	pi.on("session_shutdown", resetSession);

	return {
		async startSession(ctx, replaySessionMessages) {
			const resetting = resetSession();
			const generation = sessionGeneration;
			await resetting;
			if (generation !== sessionGeneration) return;
			const config = await loadTuiConfig();
			if (generation !== sessionGeneration) return;
			if (!config.enabled) {
				math.configure(ctx, { ...config.math, enabled: false }, () => {});
				clearChrome(ctx);
				return;
			}
			const current = new TuiSession(pi, ctx, config, userHistory);
			session = current;
			math.configure(ctx, config.math, () => current.redraw());
			await current.start(replaySessionMessages);
			if (generation === sessionGeneration) math.schedule();
		},
		dispose: resetSession,
	};

	function resetSession(): Promise<void> {
		sessionGeneration += 1;
		math.reset();
		session?.dispose();
		session = undefined;
		assistantPerformance.reset();
		return userHistory.flush();
	}
}

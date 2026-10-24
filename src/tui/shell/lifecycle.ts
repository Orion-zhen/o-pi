import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearChrome } from "./chrome.ts";
import { loadTuiConfig } from "./config.ts";
import { MathInitialization } from "../chat/math/initialization.ts";
import { recordUserMessageTimestamp, resetUserMessageTimestamps } from "../chat/message-timestamp.ts";
import { TuiSession } from "./session.ts";
import { collectUserMessages } from "./snapshot.ts";
import { UserHistoryStore } from "../../harness/user-history.ts";
import { CODEX_SPEED_CHANGED } from "../../harness/codex-speed/state.ts";

export interface TuiRuntime {
	startSession(ctx: ExtensionContext, replaySessionMessages: boolean): Promise<void>;
	dispose(): Promise<void>;
}

/** 原生 TUI 入口只协调事件，资源分别由活动会话和数学初始化器持有。 */
export function createTuiRuntime(pi: ExtensionAPI): TuiRuntime {
	let session: TuiSession | undefined;
	let sessionGeneration = 0;
	const math = new MathInitialization();
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
	pi.on("agent_settled", () => {
		session?.refresh("ready");
		math.schedule();
	});

	pi.on("message_start", (event) => {
		if (session === undefined) return;
		if (event.message.role === "user") recordUserMessageTimestamp(event.message);
	});
	pi.on("session_compact", (_event, ctx) => {
		if (session !== undefined) resetUserMessageTimestamps(collectUserMessages(ctx));
	});
	pi.on("session_tree", (_event, ctx) => {
		if (session !== undefined) {
			resetUserMessageTimestamps(collectUserMessages(ctx));
			session.refresh();
		}
	});
	pi.on("session_info_changed", () => session?.refresh());
	pi.on("model_select", () => session?.refresh());
	pi.on("thinking_level_select", () => session?.refresh());
	pi.events.on(CODEX_SPEED_CHANGED, () => session?.refresh());
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
		return userHistory.flush();
	}
}

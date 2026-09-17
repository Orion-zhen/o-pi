import type { ExtensionAPI, InputEvent } from "@earendil-works/pi-coding-agent";
import { loadAutoTitleConfig, type AutoTitleConfig } from "../auto-title/config.ts";
import { generateTitle } from "../auto-title/generate.ts";

export default function autoTitle(pi: ExtensionAPI): void {
	let config: AutoTitleConfig | undefined;
	let eligible = false;
	let input: InputEvent | undefined;
	let prompt: string | undefined;
	let controller: AbortController | undefined;

	function cancel(): void {
		controller?.abort();
		controller = undefined;
		prompt = undefined;
		input = undefined;
	}

	pi.on("session_start", async (_event, ctx) => {
		cancel();
		config = undefined;
		eligible = false;
		if (process.env.PI_SUBAGENT_CHILD === "1") return;
		config = await loadAutoTitleConfig(ctx.cwd);
		eligible = config.enabled && pi.getSessionName() === undefined
			&& !ctx.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "user");
	});
	pi.on("input", (event) => { input = event; });
	pi.on("before_agent_start", () => {
		// input 在技能展开前触发，message_start 确认请求已进入会话。
		prompt = eligible && input?.source !== "extension" ? input?.text : undefined;
		input = undefined;
	});
	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "user" || prompt === undefined) return;
		const text = prompt;
		prompt = undefined;
		eligible = false;
		if (!text.trim() || !config || pi.getSessionName() !== undefined) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const pending = new AbortController();
		controller = pending;
		const timeout = setTimeout(() => pending.abort(), 30_000);
		timeout.unref();
		void generateTitle(config, text, ctx, pending.signal).then((title) => {
			if (pending.signal.aborted || controller !== pending
				|| ctx.sessionManager.getSessionId() !== sessionId || pi.getSessionName() !== undefined) return;
			pi.setSessionName(title);
		}).catch((error: unknown) => {
			// 命名是可选后台任务，失败只通知宿主，不中断主会话。
			if (!pending.signal.aborted) ctx.ui.notify(`Auto-title: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}).finally(() => {
			clearTimeout(timeout);
			if (controller === pending) controller = undefined;
		});
	});
	pi.on("session_info_changed", () => { eligible = false; cancel(); });
	pi.on("session_shutdown", () => { eligible = false; cancel(); });
}

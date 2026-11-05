import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { loadAutoTitleConfig, type AutoTitleConfig } from "../auto-title/config.ts";
import { generateTitle } from "../auto-title/generate.ts";

export type AutoTitleState = "generating" | "complete" | undefined;
export type AutoTitleGenerator = () => Promise<void>;

export default function autoTitle(pi: ExtensionAPI, options: {
	signal?: AbortSignal;
	changed?: (state: AutoTitleState) => void;
	bind?: (generate: AutoTitleGenerator | undefined) => void;
} = {}): void {
	let eligible: AutoTitleConfig | undefined;
	let input: InputEvent | undefined;
	let prompt: { text: string; config: AutoTitleConfig } | undefined;
	let controller: AbortController | undefined;

	function cancel(): void {
		if (controller) {
			controller.abort();
			controller = undefined;
			options.changed?.(undefined);
		}
		prompt = undefined;
		input = undefined;
	}

	async function generate(config: AutoTitleConfig, messages: readonly AgentMessage[], ctx: ExtensionContext): Promise<void> {
		cancel();
		const name = pi.getSessionName();
		const pending = new AbortController();
		controller = pending;
		options.changed?.("generating");
		const signal = options.signal ? AbortSignal.any([options.signal, pending.signal]) : pending.signal;
		try {
			const title = await generateTitle(config, messages, ctx, signal);
			if (signal.aborted || pi.getSessionName() !== name) return;
			controller = undefined;
			let state: AutoTitleState;
			try {
				pi.setSessionName(title);
				state = "complete";
			} finally { options.changed?.(state); }
		} catch (error) {
			if (!signal.aborted) throw error;
		} finally {
			if (controller === pending) {
				controller = undefined;
				options.changed?.(undefined);
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		cancel();
		options.bind?.(undefined);
		options.changed?.(undefined);
		eligible = undefined;
		if (process.env.PI_SUBAGENT_CHILD === "1") return;
		const config = await loadAutoTitleConfig(ctx.cwd);
		if (config.enabled && pi.getSessionName() === undefined
			&& !ctx.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "user")) eligible = config;
		options.bind?.(() => {
			eligible = undefined;
			return generate(config, ctx.sessionManager.getBranch().flatMap((entry) => entry.type === "message" ? [entry.message] : []), ctx);
		});
	});
	pi.on("input", (event) => { input = event; });
	pi.on("before_agent_start", (event) => {
		// input 在技能展开前触发，message_start 确认用户请求已进入会话。
		prompt = event.messageType === "user" && eligible && input?.source !== "extension" ? { text: event.prompt, config: eligible } : undefined;
		input = undefined;
	});
	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "user" || prompt === undefined) return;
		const { text, config } = prompt;
		prompt = undefined;
		eligible = undefined;
		if (!text.trim() || pi.getSessionName() !== undefined) return;
		void generate(config, [{ role: "user", content: text, timestamp: event.message.timestamp }], ctx).catch((error: unknown) => {
			// 命名是可选后台任务，失败只通知宿主，不中断主会话。
			ctx.ui.notify(`Auto-title: ${error instanceof Error ? error.message : String(error)}`, "warning");
		});
	});
	pi.on("session_info_changed", () => { eligible = undefined; cancel(); });
	pi.on("session_shutdown", () => { eligible = undefined; options.bind?.(undefined); cancel(); });
}

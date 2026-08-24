import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DiscordPresenceService,
	type DiscordPresenceServiceOptions,
	type PresenceStartContext,
} from "../../src/discord-presence/service.js";
import { StreamingToolCallTracker } from "../../src/discord-presence/streaming.js";

const COMMAND_NAME = "presence";
const COMMAND_DESCRIPTION = "Control Discord rich presence.";
const COMMAND_COMPLETIONS = ["on", "off", "status", "reload"] as const;

export function createDiscordPresenceExtension(
	serviceOptions: DiscordPresenceServiceOptions = {},
): (pi: ExtensionAPI) => void {
	return function discordPresenceExtension(pi: ExtensionAPI): void {
		const service = new DiscordPresenceService(serviceOptions);
		const streamingTools = new StreamingToolCallTracker();

		pi.on("session_start", async (_event, ctx) => {
			streamingTools.clear();
			if (ctx.mode !== "tui") {
				await service.shutdown();
				return;
			}
			await service.startSession(startContext(ctx));
		});
		pi.on("turn_start", () => service.onTurnStart());
		pi.on("message_update", (event) => {
			const streamEvent = event.assistantMessageEvent;
			if (
				streamEvent.type !== "toolcall_start"
				&& streamEvent.type !== "toolcall_delta"
				&& streamEvent.type !== "toolcall_end"
			) return;
			const call = streamEvent.type === "toolcall_end"
				? streamEvent.toolCall
				: streamEvent.partial.content[streamEvent.contentIndex];
			if (call?.type !== "toolCall") throw new Error("Discord presence received an invalid tool stream event.");
			const messageKey = String(event.message.timestamp);
			const update = streamEvent.type === "toolcall_start"
				? streamingTools.start(messageKey, streamEvent.contentIndex, call)
				: streamEvent.type === "toolcall_delta"
					? streamingTools.delta(messageKey, streamEvent.contentIndex, call, streamEvent.delta)
					: streamingTools.end(messageKey, streamEvent.contentIndex, call);
			if (update !== undefined) {
				service.onToolStreamUpdate(
					update.previousToolCallId,
					update.toolCallId,
					update.toolName,
					update.args,
				);
			}
		});
		pi.on("message_end", (event) => {
			if (
				event.message.role !== "assistant"
				|| (event.message.stopReason !== "error" && event.message.stopReason !== "aborted")
			) return;
			for (const toolCallId of streamingTools.abortMessage(String(event.message.timestamp))) {
				service.onToolEnd(toolCallId);
			}
		});
		pi.on("tool_execution_start", (event) => service.onToolStart(event.toolCallId, event.toolName, event.args));
		pi.on("tool_execution_end", (event) => {
			streamingTools.finish(event.toolCallId);
			service.onToolEnd(event.toolCallId);
		});
		pi.on("agent_settled", () => {
			streamingTools.clear();
			service.onAgentSettled();
		});
		pi.on("model_select", (event) => service.onModelSelect(event.model));
		pi.on("session_info_changed", (event) => service.onSessionName(event.name));
		pi.on("session_shutdown", () => {
			streamingTools.clear();
			return service.shutdown();
		});

		pi.registerCommand(COMMAND_NAME, {
			description: COMMAND_DESCRIPTION,
			getArgumentCompletions: (argumentPrefix) => {
				const prefix = argumentPrefix.trim().toLowerCase();
				const completions = [
					...COMMAND_COMPLETIONS,
					...service.profileNames().map((profile) => `profile ${profile}`),
				];
				const matches = completions
					.filter((value) => value.startsWith(prefix))
					.map((value) => ({ label: value, value }));
				return matches.length === 0 ? null : matches;
			},
			async handler(args, ctx) {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("/presence requires TUI mode", "error");
					return;
				}
				const command = args.trim().toLowerCase();
				if (command.length === 0 || command === "status") {
					notifyStatus(ctx, service);
					return;
				}
				if (command === "on") {
					await service.enable(startContext(ctx));
					notifyStatus(ctx, service);
					return;
				}
				if (command === "off") {
					await service.disable();
					notifyStatus(ctx, service);
					return;
				}
				if (command === "reload") {
					await service.reload(startContext(ctx));
					notifyStatus(ctx, service);
					return;
				}
				const profile = parseProfile(command);
				if (profile !== undefined) {
					service.selectProfile(profile);
					notifyStatus(ctx, service);
					return;
				}
				ctx.ui.notify("usage: /presence on|off|status|reload|profile <name>", "error");
			},
		});
	};
}

function startContext(ctx: ExtensionContext): PresenceStartContext {
	return {
		cwd: ctx.cwd,
		model: ctx.model,
		sessionName: ctx.sessionManager.getSessionName(),
		idle: ctx.isIdle(),
	};
}

function parseProfile(command: string): string | undefined {
	return /^profile\s+([a-z][a-z0-9_-]{0,31})$/u.exec(command)?.[1];
}

function notifyStatus(
	ctx: Pick<ExtensionContext, "ui">,
	service: Pick<DiscordPresenceService, "status">,
): void {
	const status = service.status();
	ctx.ui.notify(
		`Discord presence: ${status.enabled ? "on" : "off"}; profile=${status.profile ?? "unavailable"}; connection=${status.connection}`,
		"info",
	);
}

export default createDiscordPresenceExtension();

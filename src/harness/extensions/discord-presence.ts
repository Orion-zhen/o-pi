import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DiscordPresenceService, type PresenceStartContext } from "../discord-presence/service.js";

const COMMAND_NAME = "presence";
const COMMAND_DESCRIPTION = "Control Discord rich presence.";
const COMMAND_COMPLETIONS = ["on", "off", "status", "reload"] as const;

export default function discordPresenceExtension(pi: ExtensionAPI): void {
	const service = new DiscordPresenceService();
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) {
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
		service.onToolStream({
			messageKey: String(event.message.timestamp),
			contentIndex: streamEvent.contentIndex,
			call,
			...(streamEvent.type === "toolcall_delta"
				? { phase: "delta", delta: streamEvent.delta } as const
				: { phase: streamEvent.type === "toolcall_start" ? "start" : "end" } as const),
		});
	});
	pi.on("message_end", (event) => {
		if (
			event.message.role !== "assistant"
			|| (event.message.stopReason !== "error" && event.message.stopReason !== "aborted")
		) return;
		service.onMessageAbort(String(event.message.timestamp));
	});
	pi.on("tool_execution_start", (event) => service.onToolStart(event.toolCallId, event.toolName, event.args));
	pi.on("tool_execution_end", (event) => service.onToolEnd(event.toolCallId));
	pi.on("agent_settled", () => service.onAgentSettled());
	pi.on("model_select", (event) => service.onModelSelect(event.model));
	pi.on("session_info_changed", (event) => service.onSessionName(event.name));
	pi.on("session_shutdown", () => service.shutdown());

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
			if (!ctx.hasUI) {
				ctx.ui.notify("/presence requires an interactive UI", "error");
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

function notifyStatus(ctx: Pick<ExtensionContext, "ui">, service: DiscordPresenceService): void {
	const status = service.status();
	ctx.ui.notify(
		`Discord presence: ${status.enabled ? "on" : "off"}; profile=${status.profile ?? "unavailable"}; connection=${status.connection}`,
		"info",
	);
}

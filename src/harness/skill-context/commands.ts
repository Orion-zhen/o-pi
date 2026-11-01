import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { findVisibleToolCallIds } from "../prune/prune.ts";
import { executeSkillLoad } from "./executor.ts";
import { isValidSkillName } from "./frontmatter.ts";
import { collectSkillCandidates } from "./loader.ts";
import { querySkillStatus } from "./state.ts";
import { SKILL_CONTEXT_MESSAGE, type SkillLoadDetails } from "./types.ts";

type CommandPi = Pick<ExtensionAPI, "appendEntry" | "getCommands" | "on" | "registerCommand" | "sendMessage">;

export function registerSkillCommands(pi: CommandPi): void {
	pi.registerCommand("skill", {
		description: "Show skills disclosed on this branch",
		async handler(args, ctx) {
			if (args.trim().length > 0) {
				ctx.ui.notify("usage: /skill", "warning");
				return;
			}
			showSkillStatus(ctx);
		},
	});

	pi.on("input", async (event, ctx) => {
		const invocation = parseSkillInvocation(event.text);
		if (invocation === undefined) return;
		try {
			await loadSkillCommand(pi, invocation.name, ctx);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : "skill loading failed.", "error");
			return { action: "handled" };
		}
		return invocation.text.length > 0 ? { action: "transform", text: invocation.text } : { action: "handled" };
	});
}

export async function loadSkillCommand(
	pi: Pick<ExtensionAPI, "appendEntry" | "getCommands" | "sendMessage">,
	name: string,
	ctx: Pick<ExtensionContext, "sessionManager">,
): Promise<void> {
	const branch = ctx.sessionManager.getBranch();
	const contextMessages = ctx.sessionManager.buildSessionProjection().messages;
	const result = await executeSkillLoad(pi, {
		name,
		loadedBy: "manual",
		candidates: collectSkillCandidates(undefined, pi.getCommands()),
		branch,
		visibleToolCallIds: findVisibleToolCallIds(contextMessages, branch),
	});
	pi.sendMessage<SkillLoadDetails>({
		customType: SKILL_CONTEXT_MESSAGE,
		content: result.content,
		display: true,
		details: result.details,
	}, { triggerTurn: false });
}

export function showSkillStatus(ctx: Pick<ExtensionCommandContext, "sessionManager" | "ui">): void {
	const snapshot = querySkillStatus(ctx.sessionManager.getBranch());
	const lines = snapshot.skills.map((load) => `  ${load.name} · ${load.scope} · ${load.loadedBy}`);
	ctx.ui.notify(["Disclosed skills:", ...(lines.length > 0 ? lines : ["  none"])].join("\n"), "info");
}

function parseSkillInvocation(text: string): { name: string; text: string } | undefined {
	const match = text.match(/^\/skill:([^\s]+)(?:\s+|$)/);
	const name = match?.[1];
	if (match === null || name === undefined || !isValidSkillName(name)) return undefined;
	return { name, text: text.slice(match[0].length) };
}

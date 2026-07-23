import {
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { findVisibleToolCallIds } from "../prune-tools/prune-tools.js";
import { executeSkillLoad } from "./executor.js";
import { isValidSkillName } from "./frontmatter.js";
import { collectSkillCandidates } from "./loader.js";
import { extractSkillLoads } from "./state.js";
import { SKILL_CONTEXT_MESSAGE, type SkillLoadDetails } from "./types.js";

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
		const name = parseSkillInvocation(event.text);
		if (name === undefined) return;
		await loadSkillCommand(pi, name, ctx);
		return { action: "handled" };
	});
}

export async function loadSkillCommand(
	pi: Pick<ExtensionAPI, "appendEntry" | "getCommands" | "sendMessage">,
	name: string,
	ctx: Pick<ExtensionContext, "sessionManager" | "ui">,
): Promise<void> {
	try {
		const branch = ctx.sessionManager.getBranch();
		const contextMessages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
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
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : "skill loading failed.", "error");
	}
}

export function showSkillStatus(ctx: Pick<ExtensionCommandContext, "sessionManager" | "ui">): void {
	const loads = extractSkillLoads(ctx.sessionManager.getBranch());
	const latest = new Map(loads.map((load) => [load.name, load]));
	const lines = [...latest.values()].map((load) => `  ${load.name} · ${load.scope} · ${load.loadedBy}`);
	ctx.ui.notify(["Disclosed skills:", ...(lines.length > 0 ? lines : ["  none"])].join("\n"), "info");
}

function parseSkillInvocation(text: string): string | undefined {
	const match = text.match(/^\/skill:([^\s]+)(?:\s|$)/);
	const name = match?.[1];
	return name !== undefined && isValidSkillName(name) ? name : undefined;
}

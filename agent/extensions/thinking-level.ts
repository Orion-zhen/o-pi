import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ThinkingLevelController } from "../../src/thinking-level/controller.js";
import { formatThinkingLevelOutcome } from "../../src/thinking-level/presentation.js";
import { ThinkingLevelPreferences } from "../../src/thinking-level/preferences.js";

const COMMAND_NAME = "thinking-level";
const COMMAND_DESCRIPTION = "Change the current thinking level.";

type ThinkingLevelAPI = Pick<
	ExtensionAPI,
	"appendEntry" | "events" | "getThinkingLevel" | "on" | "registerCommand" | "setThinkingLevel"
>;

/** 注册 /thinking-level；命令层只负责参数、dialog 与 outcome 通知。 */
export default function thinkingLevelExtension(pi: ThinkingLevelAPI): void {
	const controller = new ThinkingLevelController(pi);
	const preferences = new ThinkingLevelPreferences(pi);
	const restore = (ctx: ExtensionContext): void => {
		controller.updateModel(ctx.model);
		preferences.restore(ctx.sessionManager.getBranch(), ctx.model);
	};

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("thinking_level_select", (event, ctx) => {
		preferences.selectLevel(event.level, ctx.model);
	});
	pi.on("model_select", (event) => {
		controller.updateModel(event.model);
		preferences.selectModel(event.model);
	});

	pi.registerCommand(COMMAND_NAME, {
		description: COMMAND_DESCRIPTION,
		getArgumentCompletions: (argumentPrefix) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			const options = controller.snapshot().options.filter(({ level }) => level.startsWith(prefix));
			return options.length > 0 ? options.map(({ level, label }) => ({ label, value: level })) : null;
		},
		async handler(args, ctx) {
			const snapshot = controller.updateModel(ctx.model);
			const trimmedArgs = args.trim();
			if (trimmedArgs.length > 0) {
				notifyOutcome(ctx.ui, controller.setLevel(trimmedArgs, ctx.model));
				return;
			}

			if (ctx.model === undefined) {
				notifyOutcome(ctx.ui, controller.setLevel("", ctx.model));
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("/thinking-level requires UI when no level is provided", "error");
				return;
			}

			const title = `Thinking level (current: ${snapshot.currentLevel})`;
			const selected = ctx.mode === "tui"
				? await (await import("../../src/thinking-level/tui/selector.js")).selectThinkingLevel(
					ctx.ui,
					title,
					snapshot.options,
					snapshot.currentLevel,
				)
				: await ctx.ui.select(title, snapshot.options.map(({ label }) => label));
			if (selected === undefined) {
				controller.cancelSelection(ctx.model);
				return;
			}
			const option = ctx.mode === "tui"
				? snapshot.options.find(({ level }) => level === selected)
				: controller.findOptionByLabel(selected, ctx.model);
			if (option === undefined) return;
			notifyOutcome(ctx.ui, controller.setLevel(option.level, ctx.model));
		},
	});
}

function notifyOutcome(
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void },
	outcome: ReturnType<ThinkingLevelController["setLevel"]>,
): void {
	const notice = formatThinkingLevelOutcome(outcome);
	if (notice !== undefined) ui.notify(notice.message, notice.type);
}

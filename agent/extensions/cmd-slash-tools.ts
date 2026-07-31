import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	ToolSelectionController,
	type ToolSelectionRestoreOutcome,
} from "../../src/tool-defaults/controller.js";

type ToolSelectorModule = typeof import("../../src/tool-defaults/tui/tool-selector.js");
type ToolSelectorLoader = () => Promise<ToolSelectorModule>;

/** 注册工具选择生命周期；配置、恢复与持久化由 controller 负责。 */
export function createToolsExtension(
	loadTui: ToolSelectorLoader = () => import("../../src/tool-defaults/tui/tool-selector.js"),
): (pi: ExtensionAPI) => void {
	return function toolsExtension(pi: ExtensionAPI): void {
		const controller = new ToolSelectionController(pi);

		const restore = async (
			ctx: ExtensionContext,
			model = ctx.model,
			refreshConfig = false,
		): Promise<void> => {
			const outcome = await controller.restore({
				cwd: ctx.cwd,
				branchEntries: ctx.sessionManager.getBranch(),
				model,
				refreshConfig,
			});
			notifyRestoreIssue(ctx, outcome);
		};

		pi.registerCommand("tools", {
			description: "Enable/disable tools",
			handler: async (_args, ctx) => {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("/tools requires TUI mode", "error");
					return;
				}

				const { openToolSelector } = await loadTui();
				await openToolSelector(ctx.ui, {
					tools: controller.refreshSnapshot().tools,
					onChange(toolName, enabled) {
						controller.set(toolName, enabled);
					},
				});
			},
		});

		pi.on("session_start", async (_event, ctx) => restore(ctx, ctx.model, true));
		pi.on("session_tree", async (_event, ctx) => restore(ctx, ctx.model, true));
		pi.on("model_select", async (event, ctx) => restore(ctx, event.model));
	};
}

function notifyRestoreIssue(ctx: ExtensionContext, outcome: ToolSelectionRestoreOutcome): void {
	if (outcome.status === "degraded") {
		ctx.ui.notify(`tools config ignored: ${outcome.message}`, "warning");
		return;
	}
	if (outcome.status !== "restored" || outcome.removedTools.length === 0) return;
	ctx.ui.notify(`Removed unavailable tools from branch selection: ${outcome.removedTools.join(", ")}`, "warning");
}

export default createToolsExtension();

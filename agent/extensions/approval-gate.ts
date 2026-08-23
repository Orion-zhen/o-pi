import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createApprovalGate } from "../../src/approval/index.js";
import { formatApprovalPrompt } from "../../src/approval/runtime/interaction.js";

export default function approvalGateExtension(pi: ExtensionAPI): void {
	const gate = createApprovalGate();
	pi.on("tool_call", async (event, ctx) => gate.handleToolCall(event, {
		cwd: ctx.cwd,
		...(ctx.hasUI
			? {
				interaction: {
					approve: async (request, decision, options, optionsOverride) => {
						if (ctx.mode === "tui") {
							const { openApprovalDialog } = await import("../../src/approval/tui/dialog.js");
							return openApprovalDialog(ctx.ui, request, decision, options, optionsOverride);
						}
						return ctx.ui.select(formatApprovalPrompt(request, decision), [...options], optionsOverride);
					},
					input: (title, placeholder, optionsOverride) => ctx.ui.input(title, placeholder, optionsOverride),
					notify: (message, type) => ctx.ui.notify(message, type),
				},
			}
			: {}),
	}));
}

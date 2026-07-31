import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createApprovalGate } from "../../src/approval/gate.js";

export default function approvalGateExtension(pi: ExtensionAPI): void {
	const gate = createApprovalGate();
	pi.on("tool_call", async (event, ctx) => gate.handleToolCall(event, {
		cwd: ctx.cwd,
		...(ctx.hasUI
			? {
				interaction: {
					select: (title, options, optionsOverride) => ctx.ui.select(title, options, optionsOverride),
					input: (title, placeholder, optionsOverride) => ctx.ui.input(title, placeholder, optionsOverride),
					notify: (message, type) => ctx.ui.notify(message, type),
				},
			}
			: {}),
	}));
}

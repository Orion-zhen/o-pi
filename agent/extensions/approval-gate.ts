import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadApprovalGateConfig } from "../../src/approval/config.js";
import { APPROVAL_STATUS_CHANNEL, type ApprovalStatusEvent } from "../../src/approval/events.js";
import { createApprovalGate } from "../../src/approval/index.js";
import { buildBashApprovalRequest } from "../../src/approval/request/build.js";
import { formatBashPolicyEvaluation } from "../../src/approval/rules/bash-facts.js";
import { evaluateBashGatePolicy } from "../../src/approval/rules/policy.js";
import { formatApprovalPrompt } from "../../src/approval/runtime/interaction.js";

export default function approvalGateExtension(pi: ExtensionAPI): void {
	const gate = createApprovalGate();
	pi.registerCommand("approval-check", {
		description: "Explain the Bash gate decision without executing the command.",
		async handler(args, ctx) {
			const command = args.trim();
			if (command.length === 0) {
				ctx.ui.notify("Usage: /approval-check <bash command>", "warning");
				return;
			}
			const [config, request] = await Promise.all([
				loadApprovalGateConfig(),
				buildBashApprovalRequest(command, ctx.cwd),
			]);
			const evaluation = evaluateBashGatePolicy(request, config, { matchesAllowRule: () => false });
			const decision = config.enabled ? evaluation.decision : { kind: "allow" as const };
			ctx.ui.notify(formatBashPolicyEvaluation(evaluation.bash, decision), decision.kind === "deny" ? "warning" : "info");
		},
	});
	pi.on("tool_call", async (event, ctx) => {
		let requested = false;
		const result = await gate.handleToolCall(event, {
			cwd: ctx.cwd,
			...(ctx.hasUI
				? {
					interaction: {
						approve: async (request, decision, options, optionsOverride) => {
							requested = true;
							pi.events.emit(APPROVAL_STATUS_CHANNEL, {
								type: "requested",
								toolCallId: event.toolCallId,
								toolName: event.toolName,
							} satisfies ApprovalStatusEvent);
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
		});
		if (requested) {
			pi.events.emit(APPROVAL_STATUS_CHANNEL, {
				type: "resolved",
				toolCallId: event.toolCallId,
				outcome: result?.block === true ? "denied" : "approved",
			} satisfies ApprovalStatusEvent);
		}
		return result;
	});
}

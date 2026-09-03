import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadApprovalGateConfig } from "../../src/approval/config.js";
import { APPROVAL_STATUS_CHANNEL, type ApprovalStatusEvent } from "../../src/approval/events.js";
import { createApprovalGate, type ApprovalGateOptions } from "../../src/approval/index.js";
import { buildBashApprovalRequest } from "../../src/approval/request/build.js";
import { formatBashPolicyEvaluation } from "../../src/approval/rules/bash-facts.js";
import { evaluateBashGatePolicy } from "../../src/approval/rules/policy.js";
import { formatApprovalPrompt } from "../../src/approval/runtime/interaction.js";
import {
	attachPrivateNetworkGrant,
	createPrivateNetworkGrantFor,
} from "../../src/web-tools/network/private-network-grant.js";

export function createApprovalGateExtension(options: ApprovalGateOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => registerApprovalGate(pi, options);
}

function registerApprovalGate(pi: ExtensionAPI, options: ApprovalGateOptions): void {
	const gate = createApprovalGate(options);
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
			onApproved(request) {
				if (request.detail.kind !== "webfetch") return;
				attachPrivateNetworkGrant(
					event.input,
					createPrivateNetworkGrantFor(request.detail.origin, request.detail.addresses),
				);
			},
			...(ctx.hasUI
				? {
					interaction: {
						approve: async (request, decision, approvalOptions, optionsOverride) => {
							requested = true;
							pi.events.emit(APPROVAL_STATUS_CHANNEL, {
								type: "requested",
								toolCallId: event.toolCallId,
								toolName: event.toolName,
							} satisfies ApprovalStatusEvent);
							if (ctx.mode === "tui") {
								const { openApprovalDialog } = await import("../../src/approval/tui/dialog.js");
								return openApprovalDialog(ctx.ui, request, decision, approvalOptions, optionsOverride);
							}
							return ctx.ui.select(formatApprovalPrompt(request, decision), [...approvalOptions], optionsOverride);
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
				outcome: result === undefined ? "approved" : "denied",
			} satisfies ApprovalStatusEvent);
		}
		return result;
	});
}

const approvalGateExtension = createApprovalGateExtension();

export default approvalGateExtension;

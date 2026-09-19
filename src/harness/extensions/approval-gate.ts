import { type ExtensionUIContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ApprovalInteractionPort } from "../approval/runtime/interaction.ts";
import { canPresent, type Presenter } from "../presentation.ts";

import { loadApprovalGateConfig } from "../approval/config.ts";
import { APPROVAL_STATUS_CHANNEL, type ApprovalStatusEvent } from "../approval/events.ts";
import { createApprovalGate, type ApprovalOutcome } from "../approval/index.ts";
import { buildApprovalRequest, isApprovalToolCall } from "../approval/pi/request.ts";
import { buildBashApprovalRequest } from "../approval/request/bash/parse.ts";
import { formatBashPolicyEvaluation } from "../approval/rules/bash-facts.ts";
import { evaluateBashGatePolicy } from "../approval/rules/policy.ts";
import { formatApprovalPrompt } from "../approval/presentation.ts";
import { attachPrivateNetworkGrant, createPrivateNetworkGrantFor } from "../web-tools/network/private-network-grant.ts";

export type ApprovalPresenter = Presenter<(
	ui: ExtensionUIContext,
	...args: Parameters<ApprovalInteractionPort["approve"]>
) => ReturnType<ApprovalInteractionPort["approve"]>>;
export default function approvalGateExtension(pi: ExtensionAPI, present?: ApprovalPresenter): void {
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
			ctx.ui.notify(
				formatBashPolicyEvaluation(evaluation.bash, decision),
				decision.kind === "deny" ? "warning" : "info",
			);
		},
	});
	pi.on("tool_call", async (event, ctx) => {
		if (!isApprovalToolCall(event)) return;
		const config = await loadApprovalGateConfig();
		if (!config.enabled) return;
		const request = await buildApprovalRequest(event, ctx.cwd);
		if (request === undefined) return;

		let requested = false;
		let outcome: ApprovalOutcome | undefined;
		try {
			outcome = await gate.authorize(
				request,
				config,
				ctx.hasUI
					? {
							approve: async (request, decision, approvalOptions, dialogOptions) => {
								requested = true;
								pi.events.emit(APPROVAL_STATUS_CHANNEL, {
									type: "requested",
									toolCallId: event.toolCallId,
									toolName: event.toolName,
								} satisfies ApprovalStatusEvent);
								if (present !== undefined && canPresent(ctx, present)) {
									return present.show(ctx.ui, request, decision, approvalOptions, dialogOptions);
								}
								return ctx.ui.select(formatApprovalPrompt(request, decision), [...approvalOptions], dialogOptions);
							},
							input: (title, placeholder, dialogOptions) => ctx.ui.input(title, placeholder, dialogOptions),
							notify: (message, type) => ctx.ui.notify(message, type),
						}
					: undefined,
			);
			if (outcome.kind === "blocked") return { block: true, reason: outcome.reason };
			if (request.tool === "webfetch") {
				attachPrivateNetworkGrant(
					event.input,
					createPrivateNetworkGrantFor(request.detail.origin, request.detail.addresses),
				);
			}
		} finally {
			if (requested) {
				pi.events.emit(APPROVAL_STATUS_CHANNEL, {
					type: "resolved",
					toolCallId: event.toolCallId,
					outcome: outcome?.kind === "approved" ? "approved" : "denied",
				} satisfies ApprovalStatusEvent);
			}
		}
	});
}

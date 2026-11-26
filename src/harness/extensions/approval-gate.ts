import type { ExtensionContext, ExtensionUIContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ApprovalInteractionPort } from "../approval/runtime/interaction.ts";
import { canPresent, type Presenter } from "../presentation.ts";

import { loadApprovalGateConfig } from "../approval/config.ts";
import { APPROVAL_STATUS_CHANNEL, type ApprovalStatusEvent } from "../approval/events.ts";
import { createApprovalGate, type ApprovalOutcome } from "../approval/index.ts";
import { buildFileApprovalRequest, buildWebFetchApprovalRequest, isApprovalToolCall, type ApprovalToolCall } from "../approval/pi/request.ts";
import { buildBashApprovalRequest } from "../approval/request/bash/parse.ts";
import { prepareBashCall, saveBashCall, type BashParams } from "../bash-runtime/prepare.ts";
import { evaluateBashGatePolicy } from "../approval/rules/policy.ts";
import { approvalText, formatBashPolicyEvaluation, formatApprovalPrompt } from "../approval/presentation.ts";
import type { SessionApprovalStore } from "../approval/rules/store.ts";
import type { ApprovalRequest } from "../approval/types.ts";
import { preflightWebFetch } from "../web-tools/fetch/approval-preflight.ts";

type PreparedApproval = { request: ApprovalRequest; onApproved?: (() => void) | undefined } | { error: string };

async function inspectBashCall(input: BashParams, ctx: ExtensionContext) {
	const call = await prepareBashCall(input, ctx);
	if (call.kind === "error") return { error: call.message };
	const request = await buildBashApprovalRequest(input.command, call);
	return { request, onApproved: () => saveBashCall(input, call) };
}

async function prepareApproval(event: ApprovalToolCall, ctx: ExtensionContext): Promise<PreparedApproval> {
	switch (event.toolName) {
		case "bash": return inspectBashCall(event.input, ctx);
		case "webfetch": {
			const web = await preflightWebFetch(event.input);
			if (!("target" in web)) return web;
			const request = buildWebFetchApprovalRequest(ctx.cwd, web.target);
			return { request, onApproved: web.grantPrivateAccess };
		}
		case "write":
		case "edit": return { request: buildFileApprovalRequest(event, ctx.cwd) };
	}
}

export type ApprovalPresenter = Presenter<(
	ui: ExtensionUIContext,
	...args: Parameters<ApprovalInteractionPort["approve"]>
) => ReturnType<ApprovalInteractionPort["approve"]>>;
export default function approvalGateExtension(pi: ExtensionAPI, present?: ApprovalPresenter, store?: SessionApprovalStore): void {
	const gate = createApprovalGate(store);
	pi.registerCommand("approval-check", {
		description: "Explain the Bash gate decision without executing the command.",
		async handler(args, ctx) {
			const command = args.trim();
			if (command.length === 0) {
				ctx.ui.notify("Usage: /approval-check <bash command>", "warning");
				return;
			}
			const [config, inspection] = await Promise.all([
				loadApprovalGateConfig(),
				inspectBashCall({ command }, ctx),
			]);
			if ("error" in inspection) return ctx.ui.notify(inspection.error, "warning");
			const evaluation = evaluateBashGatePolicy(inspection.request, config, { matchesAllowRule: () => false });
			const decision = config.enabled ? evaluation.decision : { kind: "allow" as const };
			ctx.ui.notify(
				approvalText(formatBashPolicyEvaluation(inspection.request, evaluation.bash, decision)),
				decision.kind === "deny" ? "warning" : "info",
			);
		},
	});
	pi.on("tool_call", async (event, ctx) => {
		if (!isApprovalToolCall(event)) return;
		const config = await loadApprovalGateConfig();
		if (!config.enabled) return;
		const prepared = await prepareApproval(event, ctx);
		if ("error" in prepared) return { block: true, reason: prepared.error };

		let requested = false;
		let outcome: ApprovalOutcome | undefined;
		try {
			outcome = await gate.authorize(
				prepared.request,
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
								return ctx.ui.select(formatApprovalPrompt(request, decision), [...approvalOptions], { ...dialogOptions, blockedKind: "permission" });
							},
							input: (title, placeholder, dialogOptions) => ctx.ui.input(title, placeholder, dialogOptions),
						}
					: undefined,
			);
			if (outcome.kind === "blocked") return { block: true, reason: outcome.reason };
			prepared.onApproved?.();
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

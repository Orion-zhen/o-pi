import type { ExtensionContext, ExtensionUIContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ALLOW_ONCE, ApprovalInteractionPort } from "../approval/runtime/interaction.ts";
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
import type { Askpass } from "../bash-runtime/askpass.ts";

type PreparedApproval = { request: ApprovalRequest; sudoToolCallId?: string | undefined; onApproved?: ((askpass?: Askpass) => void) | undefined } | { error: string };

async function inspectBashCall(input: BashParams, ctx: ExtensionContext, sudoToolCallId?: string) {
	const call = await prepareBashCall(input, ctx);
	if (call.kind === "error") return { error: call.message };
	const request = await buildBashApprovalRequest(input.command, call, { askpass: sudoToolCallId !== undefined, signal: ctx.signal });
	const command = request.askpassCommand;
	if (command === undefined) return { request, onApproved: () => saveBashCall(input, call) };
	return { request, sudoToolCallId, onApproved: (askpass?: Askpass) => saveBashCall(input, askpass ? { ...call, command, askpass } : call) };
}

async function prepareApproval(event: ApprovalToolCall, ctx: ExtensionContext, interactive: boolean): Promise<PreparedApproval> {
	switch (event.toolName) {
		case "bash": return inspectBashCall(event.input, ctx, interactive ? event.toolCallId : undefined);
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

export type ApprovalResponse = string | undefined | { choice: typeof ALLOW_ONCE; askpass: Askpass };
export type ApprovalPresentationArgs = [...Parameters<ApprovalInteractionPort["approve"]>, sudoToolCallId?: string];
export type ApprovalPresenter = Presenter<(
	ui: ExtensionUIContext, ...args: ApprovalPresentationArgs
) => Promise<ApprovalResponse>>;

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
		const presenter = ctx.hasUI && canPresent(ctx, present) ? present : undefined;
		const prepared = await prepareApproval(event, ctx, presenter !== undefined);
		if ("error" in prepared) return { block: true, reason: prepared.error };

		let requested = false;
		let askpass: Askpass | undefined;
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
								if (!presenter) return ctx.ui.select(formatApprovalPrompt(request, decision), [...approvalOptions], { ...dialogOptions, blockedKind: "permission" });
								const response = await presenter.show(ctx.ui, request, decision, approvalOptions, dialogOptions, prepared.sudoToolCallId);
								if (typeof response !== "object") return response;
								askpass = response.askpass;
								return response.choice;
							},
							input: (title, placeholder, dialogOptions) => ctx.ui.input(title, placeholder, dialogOptions),
						}
					: undefined,
			);
			if (outcome.kind === "blocked") return { block: true, reason: outcome.reason };
			prepared.onApproved?.(askpass);
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

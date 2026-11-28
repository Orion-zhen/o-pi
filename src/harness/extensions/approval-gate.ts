import type { ExtensionContext, ExtensionUIContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ApprovalAnswer, ApprovalInteraction } from "../approval/runtime/interaction.ts";
import { canPresent, type Presenter } from "../presentation.ts";

import { loadApprovalGateConfig } from "../approval/config.ts";
import { APPROVAL_STATUS_CHANNEL, type ApprovalStatusEvent } from "../approval/events.ts";
import { createApprovalGate, type ApprovalOutcome } from "../approval/index.ts";
import { buildFileApprovalRequest, buildWebFetchApprovalRequest, isApprovalToolCall, type ApprovalToolCall } from "../approval/pi/request.ts";
import { buildPowerShellApprovalRequest } from "../approval/request/powershell.ts";
import { buildBashApprovalRequest } from "../approval/request/bash/parse.ts";
import type { ShellName } from "../shell-runtime/platform.ts";
import { prepareShellCall, saveShellCall, type ShellParams } from "../shell-runtime/prepare.ts";
import { evaluateShellGatePolicy } from "../approval/rules/policy.ts";
import { approvalText, formatShellPolicyEvaluation, formatApprovalPrompt, finishApprovalChoice } from "../approval/presentation.ts";
import type { SessionApprovalStore } from "../approval/rules/store.ts";
import type { ApprovalRequest } from "../approval/types.ts";
import { preflightWebFetch } from "../web-tools/fetch/approval-preflight.ts";
import { prepareReview } from "../approval/pi/review.ts";
import { DENIED_ENTRY } from "../approval/pi/review-context.ts";
import type { Askpass } from "../shell-runtime/askpass.ts";

type PreparedApproval = { request: ApprovalRequest; sudoToolCallId?: string | undefined; onApproved?: ((askpass?: Askpass) => void) | undefined } | { error: string };

async function inspectShellCall(shell: ShellName, input: ShellParams, ctx: ExtensionContext, sudoToolCallId?: string) {
	const call = await prepareShellCall(shell, input, ctx);
	if (call.kind === "error") return { error: call.message };
	if (shell === "powershell") {
		const request = await buildPowerShellApprovalRequest(input.command, call, ctx.signal);
		return { request, onApproved: () => saveShellCall(input, call) };
	}
	const request = await buildBashApprovalRequest(input.command, call, { askpass: sudoToolCallId !== undefined, signal: ctx.signal });
	const command = request.askpassCommand;
	if (command === undefined) return { request, onApproved: () => saveShellCall(input, call) };
	return { request, sudoToolCallId, onApproved: (askpass?: Askpass) => saveShellCall(input, askpass ? { ...call, command, askpass } : call) };
}

async function prepareApproval(event: ApprovalToolCall, ctx: ExtensionContext, interactive: boolean): Promise<PreparedApproval> {
	switch (event.toolName) {
		case "bash": case "powershell": return inspectShellCall(event.toolName, event.input, ctx, interactive ? event.toolCallId : undefined);
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

export type ApprovalPresentationArgs = [...Parameters<ApprovalInteraction>, sudoToolCallId?: string];
export type ApprovalPresenter = Presenter<(
	ui: ExtensionUIContext, ...args: ApprovalPresentationArgs
) => Promise<ApprovalAnswer>>;

export default function approvalGateExtension(pi: ExtensionAPI, present?: ApprovalPresenter, store?: SessionApprovalStore): void {
	const gate = createApprovalGate(store);
	pi.registerCommand("approval-check", {
		description: "Explain the shell gate decision without executing the command.",
		async handler(args, ctx) {
			const input = args.trim();
			const shell = /^--powershell(?:\s|$)/u.test(input) ? "powershell" : "bash";
			const command = shell === "powershell" ? input.slice("--powershell".length).trimStart() : input;
			if (command.length === 0) {
				ctx.ui.notify("Usage: /approval-check [--powershell] <command>", "warning");
				return;
			}
			const [config, inspection] = await Promise.all([
				loadApprovalGateConfig(),
				inspectShellCall(shell, { command }, ctx),
			]);
			if ("error" in inspection) return ctx.ui.notify(inspection.error, "warning");
			const evaluation = evaluateShellGatePolicy(inspection.request, config.tools.shell, { matchesAllowRule: () => false });
			const decision = config.enabled ? evaluation.decision : { kind: "allow" as const };
			ctx.ui.notify(
				approvalText(formatShellPolicyEvaluation(inspection.request, evaluation.facts, decision)),
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
		let outcome: ApprovalOutcome | undefined;
		try {
			outcome = await gate.authorize(
				prepared.request,
				config,
				ctx.hasUI ? async (request, decision, options, opts) => {
					requested = true;
					pi.events.emit(APPROVAL_STATUS_CHANNEL, {
						type: "requested", toolCallId: event.toolCallId, toolName: event.toolName,
					} satisfies ApprovalStatusEvent);
					if (presenter) {
						const review = prepareReview(ctx, config.ai_review, event.parentToolCallId ?? event.toolCallId, request, decision);
						return presenter.show(ctx.ui, request, decision, options, { ...opts, ...(ctx.signal && { signal: ctx.signal }), review }, prepared.sudoToolCallId);
					}
					const choice = await ctx.ui.select(formatApprovalPrompt(request, decision), [...options], { ...opts, blockedKind: "permission" });
					return finishApprovalChoice(choice, ctx.ui, opts);
				} : undefined,
			);
			if (outcome.kind === "blocked") {
				if (config.ai_review.enabled && event.toolName !== "webfetch") pi.appendEntry(DENIED_ENTRY, event.toolCallId);
				return { block: true, reason: outcome.reason };
			}
			prepared.onApproved?.(outcome.askpass);
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

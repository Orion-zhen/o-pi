import { clampThinkingLevel, type AssistantMessage, type Tool } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compile, obj, oneOf, str } from "@earendil-works/pi-schema";
import { approvalText, hasSensitiveEnvironment } from "../presentation.ts";
import type { ReviewOpinion, ReviewPlan } from "../runtime/ai-review.ts";
import type { ApprovalDecision, ApprovalGateConfig, ApprovalRequest } from "../types.ts";
import { reviewContext, reviewPrompt } from "./review-context.ts";

const parameters = obj({ decision: { ...oneOf(["allow", "deny"]), type: "string" }, reason: str() });
const validator = compile(parameters);
const submit: Tool = {
	name: "submit_review", description: "Submit the one-time approval decision.",
	parameters,
	constrainedSampling: { type: "json_schema", strict: "prefer" },
};

function parseReview(response: AssistantMessage): ReviewOpinion {
	const calls = response.content.filter(p => p.type === "toolCall");
	const call = calls[0];
	if ((response.stopReason === "toolUse" || response.stopReason === "stop") && calls.length === 1 && call?.name === submit.name && validator.check(call.arguments)) {
		const reason = approvalText(call.arguments.reason);
		if (reason.trim()) return { decision: call.arguments.decision, reason };
	}
	throw new Error("Invalid AI approval response.");
}

export function prepareReview(ctx: ExtensionContext, config: ApprovalGateConfig["ai_review"], id: string, request: ApprovalRequest,
	decision: Extract<ApprovalDecision, { kind: "ask" }>): ReviewPlan | undefined {
	if (!config.enabled) return;
	if ("units" in request ? hasSensitiveEnvironment(request) : request.tool === "webfetch" && request.detail.redacted) return "unavailable";
	return {
		delay: config.auto_apply_seconds * 1000,
		async run(signal) {
			const model = config.model === null ? ctx.model : ctx.modelRegistry.getAll().find(m => `${m.provider}/${m.id}` === config.model);
			if (!model) throw new Error("Approval model unavailable.");
			const reasoning = clampThinkingLevel(model, config.thinking_level);
			const content = reviewContext(ctx.sessionManager.getBranch(), id, config, request, decision);
			const result = await ctx.modelRegistry.streamSimple(model, { systemPrompt: reviewPrompt, tools: [submit], messages: [{ role: "user", content, timestamp: Date.now() }] },
				{ signal, maxRetries: 0, ...(reasoning === "off" ? {} : { reasoning }) }).result();
			return parseReview(result);
		},
	};
}

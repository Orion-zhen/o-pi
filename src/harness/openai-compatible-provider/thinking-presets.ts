import type { Api, Model, ModelThinkingLevel, OpenAICompletionsCompat, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ThinkingPresetName } from "./schema.ts";

/** Chat Completions 复用 SDK 编码，只在内存中生成兼容选项。 */
export function completionsThinkingCompat(preset: ThinkingPresetName | undefined): OpenAICompletionsCompat {
	switch (preset) {
		case undefined:
		case "auto":
		case "none":
		case "model-suffix":
			return {};
		case "chat-template-enabled":
			return { thinkingFormat: "chat-template", chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } } };
		case "chat-template-effort":
			return { thinkingFormat: "chat-template", chatTemplateKwargs: { reasoning_effort: { $var: "thinking.effort" } } };
		default:
			return { thinkingFormat: preset };
	}
}

/** Responses 的非标准编码仅在显式配置时启用，未配置时保留 SDK 请求。 */
export function applyResponsesThinkingPreset(
	payload: Record<string, unknown>,
	model: Model<Api>,
	preset: ThinkingPresetName | undefined,
	level: ModelThinkingLevel,
): void {
	if (model.api !== "openai-responses" || !model.reasoning || preset === undefined || preset === "auto" || preset === "none" || preset === "openai" || preset === "model-suffix") return;
	stripThinkingPayload(payload);
	const enabled = level !== "off";
	const mapped = model.thinkingLevelMap?.[level];
	const effort = mapped === null ? undefined : mapped ?? (enabled ? level : "none");
	const supportsEffort = model.compat !== undefined
		&& "supportsReasoningEffort" in model.compat
		&& model.compat.supportsReasoningEffort === true;
	switch (preset) {
		case "openrouter":
			if (effort !== undefined) payload.reasoning = { effort };
			return;
		case "deepseek":
			if (enabled) payload.thinking = { type: "enabled" };
			else if (model.thinkingLevelMap?.off !== null) payload.thinking = { type: "disabled" };
			if (enabled && effort !== undefined && supportsEffort) payload.reasoning_effort = effort;
			return;
		case "together":
			payload.reasoning = { enabled };
			if (enabled && effort !== undefined && supportsEffort) payload.reasoning_effort = effort;
			return;
		case "zai":
			payload.thinking = enabled ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
			if (enabled && effort !== undefined && supportsEffort) payload.reasoning_effort = effort;
			return;
		case "qwen":
			payload.enable_thinking = enabled;
			return;
		case "qwen-chat-template":
			payload.chat_template_kwargs = { enable_thinking: enabled, preserve_thinking: true };
			return;
		case "chat-template-enabled":
			payload.chat_template_kwargs = { enable_thinking: enabled };
			return;
		case "chat-template-effort":
			if (effort !== undefined) payload.chat_template_kwargs = { reasoning_effort: effort };
			return;
		case "string-thinking":
			if (effort !== undefined) payload.thinking = effort;
			return;
		case "ant-ling":
			if (enabled && typeof mapped === "string") payload.reasoning = { effort: mapped };
			return;
	}
}

export function applyModelSuffixPayload(payload: Record<string, unknown>, model: Model<Api>, level: ModelThinkingLevel): void {
	stripThinkingPayload(payload);
	payload.model = suffixModelId(model.id, model.thinkingLevelMap, level);
}

export function suffixModelId(id: string, map: ThinkingLevelMap | undefined, level: ModelThinkingLevel): string {
	const mapped = map?.[level];
	return mapped !== null && (level !== "off" || mapped !== undefined) ? `${id}:${level}` : id;
}

export function stripThinkingPayload(payload: Record<string, unknown>): void {
	for (const field of ["reasoning_effort", "reasoning", "thinking", "enable_thinking", "chat_template_kwargs", "chat_template_args",
		"thinking_token_budget", "thinking_budget", "thinking_budget_tokens"]) delete payload[field];
	if (!Array.isArray(payload.include)) return;
	const include = payload.include.filter((value) => value !== "reasoning.encrypted_content");
	if (include.length > 0) payload.include = include;
	else delete payload.include;
}

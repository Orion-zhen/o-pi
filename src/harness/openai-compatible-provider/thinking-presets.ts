import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ThinkingPresetName } from "./schema.ts";

/** Responses 的非标准编码仅在显式配置时启用，未配置时保留 SDK 请求。 */
export function applyResponsesThinkingPreset(
	payload: Record<string, unknown>,
	model: Model<Api>,
	preset: ThinkingPresetName | undefined,
	level: ModelThinkingLevel,
): void {
	if (model.api !== "openai-responses" || !model.reasoning || preset === undefined || preset === "openai" || preset === "model-suffix") return;
	stripThinkingPayload(payload);
	if (preset === "none") return;
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
	const mapped = model.thinkingLevelMap?.[level];
	const useSuffix = mapped !== null && (level !== "off" || mapped !== undefined);
	payload.model = useSuffix ? `${model.id}:${level}` : model.id;
}

function stripThinkingPayload(payload: Record<string, unknown>): void {
	for (const field of ["reasoning_effort", "reasoning", "thinking", "enable_thinking", "chat_template_kwargs"]) delete payload[field];
	if (!Array.isArray(payload.include)) return;
	const include = payload.include.filter((value) => value !== "reasoning.encrypted_content");
	if (include.length > 0) payload.include = include;
	else delete payload.include;
}

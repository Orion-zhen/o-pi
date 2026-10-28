import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
type OpenAIApiName = "openai-completions" | "openai-responses";

type EffortMapping = false | "level" | "none" | "explicit";
export interface ThinkingCapabilities {
	effortControl: "unused" | "available" | "off-only";
	on: { effort: EffortMapping; toggle: boolean };
	off: { effort: EffortMapping; toggle: boolean };
}

/** SDK 未导出编码能力。只读取已合并的 compat，并用最终请求测试校验。 */
export function thinkingCapabilities(api: OpenAIApiName, providerId: string, compat: OpenAICompletionsCompat): ThinkingCapabilities {
	if (api === "openai-responses") return {
		effortControl: "unused",
		on: { effort: "level", toggle: false },
		off: { effort: providerId === "github-copilot" ? false : "none", toggle: false },
	};
	const supportsEffort = compat.supportsReasoningEffort === true;
	switch (compat.thinkingFormat ?? "openai") {
		case "openai":
			return {
				effortControl: "available",
				on: { effort: supportsEffort ? "level" : false, toggle: false },
				off: { effort: supportsEffort ? "explicit" : false, toggle: false },
			};
		case "openrouter":
		case "string-thinking":
			return {
				effortControl: "unused",
				on: { effort: "level", toggle: false },
				off: { effort: "none", toggle: false },
			};
		case "deepseek":
		case "together":
		case "zai":
		case "qwen":
			return {
				effortControl: "available",
				on: { effort: supportsEffort ? "level" : false, toggle: true },
				off: { effort: false, toggle: true },
			};
		case "qwen-chat-template":
			return {
				effortControl: "unused",
				on: { effort: false, toggle: true },
				off: { effort: false, toggle: true },
			};
		case "ant-ling":
			// SDK 在关闭思考时回落到独立 reasoning_effort 分支。
			return {
				effortControl: "off-only",
				on: { effort: "explicit", toggle: false },
				off: { effort: supportsEffort ? "explicit" : false, toggle: false },
			};
		case "chat-template":
		case "baseten": {
			const baseten = compat.thinkingFormat === "baseten";
			const template = baseten ? compat.chatTemplateArgs : compat.chatTemplateKwargs;
			const variables = Object.values(template ?? {}).filter((value) => typeof value === "object" && value !== null);
			const offVariables = variables.filter((value) => !value.omitWhenOff);
			const independentEffort = baseten && supportsEffort;
			return {
				effortControl: baseten ? "available" : "unused",
				on: {
					effort: independentEffort || variables.some((value) => value.$var === "thinking.effort") ? "level" : false,
					toggle: variables.some((value) => value.$var === "thinking.enabled"),
				},
				off: {
					effort: independentEffort || offVariables.some((value) => value.$var === "thinking.effort") ? "explicit" : false,
					toggle: offVariables.some((value) => value.$var === "thinking.enabled"),
				},
			};
		}
	}
}

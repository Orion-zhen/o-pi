import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COMMAND_NAME = "reasoning-effort";
const COMMAND_DESCRIPTION = "Change the current reasoning effort.";

/** Pi 0.80.3 CLI 与模型运行时支持的推理强度档位；off 会关闭当前模型 reasoning。 */
export const REASONING_EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LEVELS)[number];

/** 判断用户输入是否是 Pi 支持的推理强度，避免把无效字符串写入会话状态。 */
export function parseReasoningEffortLevel(input: string): ReasoningEffortLevel | undefined {
	const value = input.trim().toLowerCase();
	return REASONING_EFFORT_LEVELS.find((level) => level === value);
}

/** 注册 /reasoning-effort：无参数交互选择，有参数直接切换当前会话推理强度。 */
export default function reasoningEffortExtension(pi: Pick<ExtensionAPI, "getThinkingLevel" | "registerCommand" | "setThinkingLevel">): void {
	pi.registerCommand(COMMAND_NAME, {
		description: COMMAND_DESCRIPTION,
		getArgumentCompletions: (argumentPrefix) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			return REASONING_EFFORT_LEVELS.filter((level) => level.startsWith(prefix)).map((level) => ({
				label: level,
				value: level,
			}));
		},
		async handler(args, ctx) {
			const trimmedArgs = args.trim();
			if (trimmedArgs.length > 0) {
				setReasoningEffort(pi, trimmedArgs, (message, type) => ctx.ui.notify(message, type));
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/reasoning-effort requires UI when no level is provided", "error");
				return;
			}

			const currentLevel = pi.getThinkingLevel();
			const selected = await ctx.ui.select("Reasoning effort", [...REASONING_EFFORT_LEVELS]);
			if (!selected) return;
			setReasoningEffort(pi, selected, (message, type) => ctx.ui.notify(message, type));
			const effectiveLevel = pi.getThinkingLevel();
			if (effectiveLevel !== currentLevel && effectiveLevel !== parseReasoningEffortLevel(selected)) {
				ctx.ui.notify(`Reasoning effort clamped to ${effectiveLevel}`, "warning");
			}
		},
	});
}

function setReasoningEffort(
	pi: Pick<ExtensionAPI, "getThinkingLevel" | "setThinkingLevel">,
	input: string,
	notify: (message: string, type?: "info" | "warning" | "error") => void,
): void {
	const level = parseReasoningEffortLevel(input);
	if (!level) {
		notify(`Usage: /reasoning-effort ${REASONING_EFFORT_LEVELS.join("|")}`, "error");
		return;
	}

	pi.setThinkingLevel(level);
	notify(`Reasoning effort: ${pi.getThinkingLevel()}`, "info");
}

import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { queryThinkingDisplayCapability } from "../../src/thinking-level/display-capability.js";

const COMMAND_NAME = "thinking-level";
const COMMAND_DESCRIPTION = "Change the current thinking level.";

interface ThinkingLevelOption {
	level: ModelThinkingLevel;
	label: string;
}

type ThinkingLevelAPI = Pick<ExtensionAPI, "events" | "getThinkingLevel" | "on" | "registerCommand" | "setThinkingLevel">;

/** 注册 /thinking-level；菜单与补全只展示当前模型支持的 Pi thinking level。 */
export default function thinkingLevelExtension(pi: ThinkingLevelAPI): void {
	let currentModel: Model<Api> | undefined;
	pi.on("session_start", (_event, ctx) => {
		currentModel = ctx.model;
	});
	pi.on("model_select", (event) => {
		currentModel = event.model;
	});

	pi.registerCommand(COMMAND_NAME, {
		description: COMMAND_DESCRIPTION,
		getArgumentCompletions: (argumentPrefix) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			const options = getThinkingLevelOptions(currentModel, pi.events).filter(({ level }) => level.startsWith(prefix));
			return options.length > 0 ? options.map(({ level, label }) => ({ label, value: level })) : null;
		},
		async handler(args, ctx) {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("/thinking-level requires an active model", "error");
				return;
			}

			const options = getThinkingLevelOptions(model, pi.events);
			const trimmedArgs = args.trim().toLowerCase();
			if (trimmedArgs.length > 0) {
				const option = options.find(({ level }) => level === trimmedArgs);
				if (!option) {
					ctx.ui.notify(`Unsupported thinking level "${trimmedArgs}". Available: ${options.map(({ level }) => level).join("|")}`, "error");
					return;
				}
				setThinkingLevel(pi, option.level, (message, type) => ctx.ui.notify(message, type));
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/thinking-level requires UI when no level is provided", "error");
				return;
			}

			const currentLevel = pi.getThinkingLevel();
			const selected = await ctx.ui.select(`Thinking level (current: ${currentLevel})`, options.map(({ label }) => label));
			if (!selected) return;
			const option = options.find(({ label }) => label === selected);
			if (!option) return;
			setThinkingLevel(pi, option.level, (message, type) => ctx.ui.notify(message, type));
		},
	});
}

/** 返回 Pi 判定为可用的等级，并展示最终请求使用的布尔或字符串映射。 */
export function getThinkingLevelOptions(model: Model<Api> | undefined, events?: EventBus): ThinkingLevelOption[] {
	if (!model) return [];
	const booleanThinking = usesBooleanThinking(model)
		|| (events !== undefined && queryThinkingDisplayCapability(events, model) === "boolean");
	return getSupportedThinkingLevels(model).map((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		let label: string = level;
		if (booleanThinking) label = `${level} → ${level === "off" ? "disabled" : "enabled"}`;
		else if (typeof mapped === "string") label = `${level} → ${mapped}`;
		return { level, label };
	});
}

/** 根据模型最终生效的 compat 识别 chat_template_enabled，不耦合 provider 配置。 */
function usesBooleanThinking(model: Model<Api>): boolean {
	const compat = model.compat;
	if (
		!compat
		|| !("thinkingFormat" in compat)
		|| compat.thinkingFormat !== "chat-template"
		|| !("chatTemplateKwargs" in compat)
	) return false;
	const value = compat.chatTemplateKwargs?.enable_thinking;
	return typeof value === "object" && value !== null && value.$var === "thinking.enabled";
}

function setThinkingLevel(
	pi: Pick<ExtensionAPI, "getThinkingLevel" | "setThinkingLevel">,
	level: ModelThinkingLevel,
	notify: (message: string, type?: "info" | "warning" | "error") => void,
): void {
	pi.setThinkingLevel(level);
	notify(`Thinking level: ${pi.getThinkingLevel()}`, "info");
}

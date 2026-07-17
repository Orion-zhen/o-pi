import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COMMAND_NAME = "thinking-level";
const COMMAND_DESCRIPTION = "Change the current thinking level.";

interface ThinkingLevelOption {
	level: ModelThinkingLevel;
	label: string;
}

type ThinkingLevelAPI = Pick<ExtensionAPI, "getThinkingLevel" | "on" | "registerCommand" | "setThinkingLevel">;

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
			const options = getThinkingLevelOptions(currentModel).filter(({ level }) => level.startsWith(prefix));
			return options.length > 0 ? options.map(({ level, label }) => ({ label, value: level })) : null;
		},
		async handler(args, ctx) {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("/thinking-level requires an active model", "error");
				return;
			}

			const options = getThinkingLevelOptions(model);
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

/** 返回 Pi 判定为可用的等级，并附加显式 provider 值映射。 */
export function getThinkingLevelOptions(model: Model<Api> | undefined): ThinkingLevelOption[] {
	if (!model) return [];
	return getSupportedThinkingLevels(model).map((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		return {
			level,
			label: typeof mapped === "string" ? `${level} → ${mapped}` : level,
		};
	});
}

function setThinkingLevel(
	pi: Pick<ExtensionAPI, "getThinkingLevel" | "setThinkingLevel">,
	level: ModelThinkingLevel,
	notify: (message: string, type?: "info" | "warning" | "error") => void,
): void {
	pi.setThinkingLevel(level);
	notify(`Thinking level: ${pi.getThinkingLevel()}`, "info");
}

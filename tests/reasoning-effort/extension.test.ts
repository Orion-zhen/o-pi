import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import reasoningEffortExtension, {
	parseReasoningEffortLevel,
	REASONING_EFFORT_LEVELS,
	type ReasoningEffortLevel,
} from "../../agent/extensions/reasoning-effort.js";

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type CommandContext = Parameters<CommandOptions["handler"]>[1];
type Notification = { message: string; type: "info" | "warning" | "error" | undefined };

function registerCommand(initialLevel: ReasoningEffortLevel = "medium") {
	let commandName: string | undefined;
	let commandOptions: CommandOptions | undefined;
	let currentLevel: ReasoningEffortLevel = initialLevel;
	const notifications: Notification[] = [];

	const pi = {
		registerCommand(name, options) {
			commandName = name;
			commandOptions = options;
		},
		getThinkingLevel: () => currentLevel,
		setThinkingLevel: (level: ReasoningEffortLevel) => {
			currentLevel = level;
		},
	} satisfies Pick<ExtensionAPI, "getThinkingLevel" | "registerCommand" | "setThinkingLevel">;

	reasoningEffortExtension(pi);

	const ctx: CommandContext = {
		mode: "print",
		hasUI: false,
		ui: {
			notify(message: string, type: Notification["type"]) {
				notifications.push({ message, type });
			},
			select: async () => undefined,
		},
	} as never;

	return {
		get commandName() {
			return commandName;
		},
		get commandOptions() {
			return commandOptions;
		},
		get currentLevel() {
			return currentLevel;
		},
		notifications,
		ctx,
	};
}

describe("reasoning effort extension", () => {
	it("解析 Pi 支持的推理强度档位", () => {
		expect(parseReasoningEffortLevel(" HIGH ")).toBe("high");
		expect(parseReasoningEffortLevel("max")).toBeUndefined();
	});

	it("注册 /reasoning-effort 并提供档位补全", () => {
		const command = registerCommand();

		expect(command.commandName).toBe("reasoning-effort");
		expect(command.commandOptions?.description).toBe("Change the current reasoning effort.");
		expect(command.commandOptions?.getArgumentCompletions?.("h")).toEqual([{ label: "high", value: "high" }]);
	});

	it("带 level 参数时直接切换当前推理强度", async () => {
		const command = registerCommand();

		await command.commandOptions?.handler(" high ", command.ctx);

		expect(command.currentLevel).toBe("high");
		expect(command.notifications).toEqual([{ message: "Reasoning effort: high", type: "info" }]);
	});

	it("拒绝无效 level，且不改写当前推理强度", async () => {
		const command = registerCommand("low");

		await command.commandOptions?.handler("max", command.ctx);

		expect(command.currentLevel).toBe("low");
		expect(command.notifications).toEqual([{ message: `Usage: /reasoning-effort ${REASONING_EFFORT_LEVELS.join("|")}`, type: "error" }]);
	});

	it("无参数时通过 UI 选择推理强度", async () => {
		const command = registerCommand("medium");
		let selectTitle: string | undefined;
		let selectOptions: string[] | undefined;
		const ctx: CommandContext = {
			...command.ctx,
			mode: "tui",
			hasUI: true,
			ui: {
				...command.ctx.ui,
				select: async (title: string, options: string[]) => {
					selectTitle = title;
					selectOptions = options;
					return "minimal";
				},
			},
		} as never;

		await command.commandOptions?.handler("", ctx);

		expect(selectTitle).toBe("Reasoning effort");
		expect(selectOptions).toEqual([...REASONING_EFFORT_LEVELS]);
		expect(command.currentLevel).toBe("minimal");
		expect(command.notifications).toEqual([{ message: "Reasoning effort: minimal", type: "info" }]);
	});

	it("无参数且无 UI 时提示错误", async () => {
		const command = registerCommand("medium");

		await command.commandOptions?.handler("", command.ctx);

		expect(command.currentLevel).toBe("medium");
		expect(command.notifications).toEqual([{ message: "/reasoning-effort requires UI when no level is provided", type: "error" }]);
	});
});

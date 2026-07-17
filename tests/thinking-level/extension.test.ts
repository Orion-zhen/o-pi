import type { Model, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import thinkingLevelExtension from "../../agent/extensions/thinking-level.js";

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type CommandContext = Parameters<CommandOptions["handler"]>[1];
type Notification = { message: string; type: "info" | "warning" | "error" | undefined };
type Handler = (event: unknown, ctx: CommandContext) => void;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function createModel(options: { reasoning?: boolean; thinkingLevelMap?: ThinkingLevelMap } = {}): Model<"openai-completions"> {
	return {
		id: "model",
		name: "Model",
		api: "openai-completions",
		provider: "provider",
		baseUrl: "http://127.0.0.1/v1",
		reasoning: options.reasoning ?? true,
		...(options.thinkingLevelMap !== undefined ? { thinkingLevelMap: options.thinkingLevelMap } : {}),
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function registerCommand(model: Model<"openai-completions"> | undefined, initialLevel: ModelThinkingLevel = "medium") {
	let commandName: string | undefined;
	let commandOptions: CommandOptions | undefined;
	let currentLevel = initialLevel;
	const notifications: Notification[] = [];
	const handlers = new Map<string, Handler>();

	const pi = {
		registerCommand(name: string, options: CommandOptions) {
			commandName = name;
			commandOptions = options;
		},
		getThinkingLevel: () => currentLevel,
		setThinkingLevel: (level: ModelThinkingLevel) => {
			currentLevel = level;
		},
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
	} as unknown as Parameters<typeof thinkingLevelExtension>[0];

	thinkingLevelExtension(pi);

	const ctx: CommandContext = {
		mode: "print",
		hasUI: false,
		model,
		ui: {
			notify(message: string, type: Notification["type"]) {
				notifications.push({ message, type });
			},
			select: async () => undefined,
		},
	} as never;
	handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

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
		handlers,
		ctx,
	};
}

describe("thinking level extension", () => {
	it("注册 /thinking-level，补全只包含当前模型支持的等级并显示映射", () => {
		const command = registerCommand(createModel({
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "max", xhigh: "ultra" },
		}));

		expect(command.commandName).toBe("thinking-level");
		expect(command.commandOptions?.description).toBe("Change the current thinking level.");
		expect(command.commandOptions?.getArgumentCompletions?.("")).toEqual([
			{ label: "off", value: "off" },
			{ label: "high → max", value: "high" },
			{ label: "xhigh → ultra", value: "xhigh" },
		]);
		expect(command.commandOptions?.getArgumentCompletions?.("h")).toEqual([{ label: "high → max", value: "high" }]);
	});

	it("model_select 后补全切换到新模型的能力", () => {
		const command = registerCommand(createModel());
		const nextModel = createModel({ reasoning: false });
		command.handlers.get("model_select")?.({ type: "model_select", model: nextModel }, command.ctx);

		expect(command.commandOptions?.getArgumentCompletions?.("")).toEqual([{ label: "off", value: "off" }]);
	});

	it("带参数时只接受当前模型支持的等级", async () => {
		const command = registerCommand(createModel({ thinkingLevelMap: { minimal: null, low: null, medium: null } }));

		await command.commandOptions?.handler(" high ", command.ctx);

		expect(command.currentLevel).toBe("high");
		expect(command.notifications).toEqual([{ message: "Thinking level: high", type: "info" }]);
	});

	it("拒绝当前模型不支持的等级", async () => {
		const command = registerCommand(createModel({
			thinkingLevelMap: { minimal: null, low: null, medium: null, xhigh: null },
		}), "high");

		await command.commandOptions?.handler("minimal", command.ctx);

		expect(command.currentLevel).toBe("high");
		expect(command.notifications).toEqual([{
			message: 'Unsupported thinking level "minimal". Available: off|high',
			type: "error",
		}]);
	});

	it("无参数菜单只展示支持等级，并在标签中显示显式映射", async () => {
		const model = createModel({
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "max", xhigh: "ultra" },
		});
		const command = registerCommand(model, "high");
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
					return "xhigh → ultra";
				},
			},
		} as never;

		await command.commandOptions?.handler("", ctx);

		expect(selectTitle).toBe("Thinking level (current: high)");
		expect(selectOptions).toEqual(["off", "high → max", "xhigh → ultra"]);
		expect(command.currentLevel).toBe("xhigh");
		expect(command.notifications).toEqual([{ message: "Thinking level: xhigh", type: "info" }]);
	});

	it("无参数且无 UI 时提示错误", async () => {
		const command = registerCommand(createModel(), "medium");

		await command.commandOptions?.handler("", command.ctx);

		expect(command.currentLevel).toBe("medium");
		expect(command.notifications).toEqual([{ message: "/thinking-level requires UI when no level is provided", type: "error" }]);
	});

	it("没有当前模型时拒绝执行且不提供补全", async () => {
		const command = registerCommand(undefined, "medium");

		expect(command.commandOptions?.getArgumentCompletions?.("")).toBeNull();
		await command.commandOptions?.handler("high", command.ctx);

		expect(command.notifications).toEqual([{ message: "/thinking-level requires an active model", type: "error" }]);
	});
});

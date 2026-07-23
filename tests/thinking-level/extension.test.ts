import type { Api, Model, ModelThinkingLevel, Provider, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { createEventBus, type EventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import thinkingLevelExtension from "../../agent/extensions/thinking-level.js";
import {
	registerOpenAICompatibleProviders,
	type ModelsJsoncConfig,
	type ThinkingPresetName,
} from "../../src/openai-compatible-provider/index.js";

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type CommandContext = Parameters<CommandOptions["handler"]>[1];
type Notification = { message: string; type: "info" | "warning" | "error" | undefined };
type Handler = (event: unknown, ctx: CommandContext) => void;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function createModel(options: {
	compat?: Model<"openai-completions">["compat"];
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
} = {}): Model<"openai-completions"> {
	return {
		id: "model",
		name: "Model",
		api: "openai-completions",
		provider: "provider",
		baseUrl: "http://127.0.0.1/v1",
		reasoning: options.reasoning ?? true,
		...(options.thinkingLevelMap !== undefined ? { thinkingLevelMap: options.thinkingLevelMap } : {}),
		...(options.compat !== undefined ? { compat: options.compat } : {}),
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function registerCommand(
	model: Model<Api> | undefined,
	initialLevel: ModelThinkingLevel = "medium",
	events: EventBus = createEventBus(),
) {
	let commandName: string | undefined;
	let commandOptions: CommandOptions | undefined;
	let currentLevel = initialLevel;
	const notifications: Notification[] = [];
	const handlers = new Map<string, Handler>();

	const pi = {
		events,
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

function registerResponsesModel(
	events: EventBus,
	providerThinkingPreset: ThinkingPresetName | undefined,
	modelThinkingPreset: ThinkingPresetName | undefined,
	runtimeOverrides: { dropParams?: string[]; extraBody?: Record<string, unknown> } = {},
): Model<Api> {
	const config: ModelsJsoncConfig = {
		providers: {
			gateway: {
				baseUrl: "https://gateway.example.test/v1",
				apiKey: "EMPTY",
				api: "openai-responses",
				...(providerThinkingPreset !== undefined ? { thinkingPreset: providerThinkingPreset } : {}),
				models: [{
					id: "m",
					defaultThinkingLevel: "high",
					...(modelThinkingPreset !== undefined ? { thinkingPreset: modelThinkingPreset } : {}),
					...runtimeOverrides,
				}],
			},
		},
	};
	const registered: Provider[] = [];
	const pi = {
		events,
		registerProvider(provider: Provider) {
			registered.push(provider);
		},
		on() {},
		setThinkingLevel() {},
	} as unknown as ExtensionAPI;
	registerOpenAICompatibleProviders(pi, config, "/tmp/models.jsonc");
	const model = registered[0]?.getModels()[0];
	if (!model) throw new Error("registered model missing");
	return model;
}

describe("thinking level extension", () => {
	it("注册 /thinking-level，补全只包含当前模型支持的等级并显示映射", () => {
		const command = registerCommand(createModel({
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "max", xhigh: "ultra" },
		}));

		expect(command.commandName).toBe("thinking-level");
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

	it("chat_template_enabled 将 off 显示为 disabled，其他支持等级显示为 enabled", () => {
		const command = registerCommand(createModel({
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "max", xhigh: "ultra" },
			compat: {
				thinkingFormat: "chat-template",
				chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
			},
		}));

		expect(command.commandOptions?.getArgumentCompletions?.("")).toEqual([
			{ label: "off → disabled", value: "off" },
			{ label: "high → enabled", value: "high" },
			{ label: "xhigh → enabled", value: "xhigh" },
		]);
	});

	it.each([
		[undefined, "chat-template-enabled", true],
		["openai", "chat-template-enabled", true],
		["chat-template-enabled", undefined, true],
		["chat-template-enabled", "none", false],
		[undefined, undefined, false],
	] as const)(
		"Responses runtime 映射 provider=%s model=%s 时 boolean=%s",
		async (providerThinkingPreset, modelThinkingPreset, expectedBoolean) => {
			const events = createEventBus();
			const model = registerResponsesModel(events, providerThinkingPreset, modelThinkingPreset);
			expect(model.compat).not.toHaveProperty("thinkingFormat");

			const command = registerCommand(model, "high", events);
			const completions = await command.commandOptions?.getArgumentCompletions?.("");
			const labels = completions?.map((option) => option.label);
			expect(labels).toEqual(expectedBoolean
				? ["off → disabled", "minimal → enabled", "low → enabled", "medium → enabled", "high → enabled"]
				: ["off", "minimal", "low", "medium", "high"]);
		},
	);

	it("Pi 组合产生的新模型对象仍按 provider/model 查询 Responses runtime", async () => {
		const events = createEventBus();
		const model = registerResponsesModel(events, undefined, "chat-template-enabled");
		const composedModel: Model<Api> = { ...model, name: "Composed model" };

		const command = registerCommand(composedModel, "high", events);
		const completions = await command.commandOptions?.getArgumentCompletions?.("");
		expect(completions?.[0]?.label).toBe("off → disabled");
	});

	it.each([
		{ name: "dropParams", overrides: { dropParams: ["chat_template_kwargs"] } },
		{ name: "extraBody", overrides: { extraBody: { chat_template_kwargs: { enable_thinking: true } } } },
	])("$name 覆盖最终 payload 时不声明 boolean 映射", async ({ overrides }) => {
		const events = createEventBus();
		const model = registerResponsesModel(events, undefined, "chat-template-enabled", overrides);

		const command = registerCommand(model, "high", events);
		const completions = await command.commandOptions?.getArgumentCompletions?.("");
		expect(completions?.map((option) => option.label)).toEqual(["off", "minimal", "low", "medium", "high"]);
	});

	it("重复 provider 注册会替换旧的 Responses runtime resolver", async () => {
		const events = createEventBus();
		const oldModel = registerResponsesModel(events, undefined, "chat-template-enabled");
		registerResponsesModel(events, undefined, "none");

		const command = registerCommand(oldModel, "high", events);
		const completions = await command.commandOptions?.getArgumentCompletions?.("");
		expect(completions?.map((option) => option.label)).toEqual(["off", "minimal", "low", "medium", "high"]);
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

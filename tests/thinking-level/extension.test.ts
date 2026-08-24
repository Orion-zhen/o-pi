import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import thinkingPreferencesExtension from "../../agent/extensions/thinking-preferences.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type BranchEntry = { type: "custom"; customType: string; data: unknown };
type Handler = (event: never, ctx: ExtensionContext) => void;

function createModel(id: string, provider = "provider"): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://127.0.0.1/v1",
		reasoning: true,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function createHarness(
	model: Model<Api>,
	initialLevel: ModelThinkingLevel,
	initialBranch: BranchEntry[] = [],
	normalize: (level: ModelThinkingLevel) => ModelThinkingLevel = (level) => level,
) {
	let currentLevel = initialLevel;
	let branch = [...initialBranch];
	const handlers = new Map<string, Handler>();
	const pi = {
		appendEntry(customType: string, data: unknown) {
			branch.push({ type: "custom", customType, data });
		},
		getThinkingLevel: () => currentLevel,
		setThinkingLevel(level: ModelThinkingLevel) {
			currentLevel = normalize(level);
		},
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	};
	thinkingPreferencesExtension(pi);

	const contextFor = (currentModel: Model<Api>): ExtensionContext => ({
		model: currentModel,
		sessionManager: { getBranch: () => branch },
	} as unknown as ExtensionContext);
	const emit = (event: string, payload: object, currentModel: Model<Api> = model): void => {
		handlers.get(event)?.(payload as never, contextFor(currentModel));
	};

	return {
		emit,
		contextFor,
		get level() { return currentLevel; },
		set level(value: ModelThinkingLevel) { currentLevel = value; },
		get branch() { return branch; },
		set branch(value: BranchEntry[]) { branch = [...value]; },
	};
}

function preference(model: Model<Api>, level: ModelThinkingLevel): BranchEntry {
	return {
		type: "custom",
		customType: "thinking-level-preference",
		data: { provider: model.provider, modelId: model.id, level },
	};
}

describe("thinking preferences extension", () => {
	it("按模型记忆原生 /thinking 选择并在模型切换后恢复", () => {
		const sol = createModel("sol", "openai-codex");
		const deepseek = createModel("deepseek", "opencode");
		const harness = createHarness(sol, "high");
		harness.emit("session_start", { type: "session_start", reason: "startup" });

		harness.emit("model_select", { type: "model_select", model: deepseek }, deepseek);
		harness.level = "xhigh";
		harness.emit("thinking_level_select", { type: "thinking_level_select", level: "xhigh", previousLevel: "high" }, deepseek);

		// Pi 会在 model_select 前临时限制继承等级。该事件不能覆盖旧模型偏好。
		harness.level = "high";
		harness.emit("thinking_level_select", { type: "thinking_level_select", level: "high", previousLevel: "xhigh" }, sol);
		harness.emit("model_select", { type: "model_select", model: sol }, sol);
		expect(harness.level).toBe("high");

		harness.emit("model_select", { type: "model_select", model: deepseek }, deepseek);
		expect(harness.level).toBe("xhigh");
		expect(harness.branch.filter((entry) => entry.customType === "thinking-level-preference")).toEqual([
			preference(sol, "high"),
			preference(deepseek, "high"),
			preference(deepseek, "xhigh"),
		]);
	});

	it("从当前分支恢复偏好，并在 session_tree 后按新分支重建", () => {
		const sol = createModel("sol", "openai-codex");
		const deepseek = createModel("deepseek", "opencode");
		const harness = createHarness(sol, "medium", [preference(sol, "high")]);

		harness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(harness.level).toBe("high");

		harness.branch = [preference(deepseek, "xhigh")];
		harness.level = "high";
		harness.emit("session_tree", { type: "session_tree" }, deepseek);
		expect(harness.level).toBe("xhigh");
	});

	it("历史偏好不再受支持时保存 Pi 限制后的实际等级", () => {
		const model = createModel("sol", "openai-codex");
		const harness = createHarness(model, "medium", [preference(model, "xhigh")], (level) => level === "xhigh" ? "high" : level);

		harness.emit("session_start", { type: "session_start", reason: "startup" });

		expect(harness.level).toBe("high");
		expect(harness.branch.at(-1)).toEqual(preference(model, "high"));
	});
});

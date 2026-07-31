import type { Model, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { ThinkingLevelController } from "../../src/thinking-level/controller.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

describe("ThinkingLevelController", () => {
	it("计算映射 option、校验并返回 JSON-safe set outcome", () => {
		let level: ModelThinkingLevel = "high";
		const controller = new ThinkingLevelController({
			getThinkingLevel: () => level,
			setThinkingLevel(next) {
				level = next;
			},
		});
		const model = createModel({
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "max", xhigh: "ultra" },
		});

		expect(controller.updateModel(model)).toEqual({
			model: { provider: "provider", id: "model" },
			currentLevel: "high",
			options: [
				{ level: "off", label: "off" },
				{ level: "high", label: "high → max" },
				{ level: "xhigh", label: "xhigh → ultra" },
			],
		});
		const outcome = controller.setLevel(" XHIGH ");
		expect(outcome).toMatchObject({
			status: "applied",
			code: "LEVEL_SET",
			requestedLevel: "xhigh",
			effectiveLevel: "xhigh",
			snapshot: { currentLevel: "xhigh" },
		});
		expect(structuredClone(outcome)).toEqual(JSON.parse(JSON.stringify(outcome)));
	});

	it("稳定拒绝缺失模型和不支持的等级", () => {
		let level: ModelThinkingLevel = "medium";
		const controller = new ThinkingLevelController({
			getThinkingLevel: () => level,
			setThinkingLevel(next) {
				level = next;
			},
		});

		expect(controller.setLevel("high")).toEqual({
			status: "rejected",
			code: "MODEL_REQUIRED",
			snapshot: {
				model: null,
				currentLevel: "medium",
				options: [],
			},
		});

		const model = createModel({ thinkingLevelMap: { minimal: null, low: null, medium: null, xhigh: null } });
		expect(controller.setLevel("minimal", model)).toMatchObject({
			status: "rejected",
			code: "UNSUPPORTED_LEVEL",
			requestedLevel: "minimal",
			availableLevels: ["off", "high"],
		});
		expect(level).toBe("medium");
	});

	it("模型切换后 snapshot 立即反映新能力", () => {
		const controller = new ThinkingLevelController({
			getThinkingLevel: () => "off",
			setThinkingLevel() {},
		});
		controller.updateModel(createModel());
		expect(controller.snapshot().options.map(({ level }) => level)).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
		]);

		controller.updateModel(createModel({ reasoning: false }));
		expect(controller.snapshot().options).toEqual([{ level: "off", label: "off" }]);
	});

	it("布尔 compat 映射、取消和 setter 失败均为结构化结果", () => {
		const model = createModel({
			compat: {
				thinkingFormat: "chat-template",
				chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
			},
		});
		const controller = new ThinkingLevelController({
			getThinkingLevel: () => "medium",
			setThinkingLevel() {
				throw new Error("write failed");
			},
		});
		const snapshot = controller.updateModel(model);
		expect(snapshot.options).toEqual([
			{ level: "off", label: "off → disabled" },
			{ level: "minimal", label: "minimal → enabled" },
			{ level: "low", label: "low → enabled" },
			{ level: "medium", label: "medium → enabled" },
			{ level: "high", label: "high → enabled" },
		]);
		expect(controller.cancelSelection()).toMatchObject({
			status: "cancelled",
			code: "SELECTION_CANCELLED",
		});
		expect(controller.setLevel("high")).toMatchObject({
			status: "failed",
			code: "SET_FAILED",
			requestedLevel: "high",
			message: "write failed",
		});
	});
});

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

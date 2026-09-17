import { describe, expect, it } from "vitest";
import { modelSetup } from "../../src/gui/ui/model-setup.ts";

const model = { provider: "test", id: "first", name: "First", contextWindow: 128000 };

describe("模型配置引导", () => {
	it("干净配置或当前模型凭据已移除时引导认证", () => {
		expect(modelSetup({ model: null, models: [] })?.kind).toBe("auth");
		expect(modelSetup({ model, models: [] })?.kind).toBe("auth");
	});
	it("已有可用模型但未选中时引导选择模型", () => {
		expect(modelSetup({ model: null, models: [model] })?.kind).toBe("model");
		expect(modelSetup({ model, models: [{ ...model, id: "second" }] })?.kind).toBe("model");
	});
	it("当前模型可用时不显示引导，不依赖首次启动标记或凭据存储方式", () => {
		expect(modelSetup({ model, models: [model] })).toBeNull();
	});
});

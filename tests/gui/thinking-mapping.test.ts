import { expect, it } from "vitest";
import { parseModelsDocument } from "../../src/harness/openai-compatible-provider/validation.ts";
import { editServiceConfig, serviceModels } from "../../src/gui/ui/model-services/service-draft.ts";
import { thinkingMapping } from "../../src/gui/ui/model-services/thinking-mapping.ts";

const provider = { api: "openai-responses" };
const model = { id: "m", reasoning: true };

it("编辑、禁用和还原映射只影响目标等级，服务商 max 不启用 opi 的 max", () => {
	let content = JSON.stringify({ providers: { local: { ...provider, models: [model] } } });
	const path = ["providers", "local", "models", 0, "thinkingLevelMap"];
	const rows = () => {
		const local = parseModelsDocument(content).providers.local;
		if (!local) throw new Error("缺少服务");
		const entry = serviceModels(local, [])[0];
		if (!entry) throw new Error("缺少模型");
		return thinkingMapping(local, entry.defaults, entry.configured, entry.id).rows;
	};
	expect(rows().filter((row) => row.available).map((row) => row.level)).toEqual(["off", "minimal", "low", "medium", "high"]);
	expect(rows().find((row) => row.level === "off")).toMatchObject({ placeholder: "none", value: "", modified: false });
	content = editServiceConfig(content, [...path, "xhigh"], "max");
	content = editServiceConfig(content, [...path, "minimal"], null);
	expect(rows().find((row) => row.level === "xhigh")).toMatchObject({ available: true, value: "max", modified: true });
	expect(rows().find((row) => row.level === "max")).toMatchObject({ available: false });
	expect(rows().find((row) => row.level === "minimal")).toMatchObject({ available: false, enableValue: undefined });
	content = editServiceConfig(content, [...path, "minimal"], undefined);
	expect(rows().find((row) => row.level === "minimal")).toMatchObject({ available: true, modified: false });
	expect(rows().find((row) => row.level === "xhigh")).toMatchObject({ value: "max" });
	content = editServiceConfig(content, path, undefined);
	expect(rows().find((row) => row.level === "xhigh")).toMatchObject({ available: false, modified: false });
});

it("发现模型与手动模型覆盖继承原始映射，编辑手动定义本身不把旧值当作默认", () => {
	const models = [{ ...model, name: "m", contextWindow: 4096, maxTokens: 1024, input: ["text"], thinkingLevelMap: { high: "max", minimal: null } }];
	for (const manual of [false, true]) {
		const entry = serviceModels({ ...provider, ...(manual ? { models } : {}), modelOverrides: { m: { thinkingLevelMap: { high: "custom" } } } }, manual ? [] : models)[0];
		if (!entry) throw new Error("缺少模型");
		const mapping = thinkingMapping(provider, entry.defaults, entry.configured, "m");
		expect(mapping.rows.find((row) => row.level === "high")).toMatchObject({ value: "custom", placeholder: "max" });
		expect(mapping.rows.find((row) => row.level === "minimal")).toMatchObject({ available: false, modified: false, enableValue: "minimal" });
		const reset = thinkingMapping(provider, entry.defaults, {}, "m");
		expect(reset.rows.find((row) => row.level === "high")).toMatchObject({ value: "", placeholder: "max", modified: false });
	}
	expect(serviceModels({ models }, [])[0]?.defaults).toEqual({});
});

it("模型后缀按启用的 opi 等级展示目标模型 ID", () => {
	const config = { ...provider, thinkingPreset: "model-suffix" };
	const defaults = { ...model, thinkingLevelMap: { high: "high", minimal: null } };
	const mapping = thinkingMapping(config, defaults, {}, "m");
	expect(mapping.suffix).toBe(true);
	expect(mapping.rows.find((row) => row.level === "off")).toMatchObject({ targetModel: "m" });
	expect(mapping.rows.find((row) => row.level === "high")).toMatchObject({ available: true, targetModel: "m:high" });
	const enabled = mapping.rows.find((row) => row.level === "minimal")?.enableValue;
	const edited = thinkingMapping(config, defaults, { thinkingLevelMap: { high: null, minimal: enabled } }, "m");
	expect(edited.rows.find((row) => row.level === "high")).toMatchObject({ available: false });
	expect(edited.rows.find((row) => row.level === "minimal")).toMatchObject({ available: true, targetModel: "m:minimal" });
});

it("非推理模型只允许 off，按当前协议提示默认请求值", () => {
	expect(thinkingMapping(provider, {}, {}, "m").rows.filter((row) => row.available).map((row) => row.level)).toEqual(["off"]);
	const completions = { api: "openai-completions" };
	expect(thinkingMapping(completions, {}, model, "m").rows[0]?.placeholder).toBe("协议默认");
	expect(thinkingMapping({ ...completions, compat: { thinkingFormat: "openai" } }, {}, model, "m").rows[0]?.placeholder).toBe("不发送等级值");
	expect(thinkingMapping({ ...completions, compat: { thinkingFormat: "openrouter" } }, {}, model, "m").rows[0]?.placeholder).toBe("none");
});

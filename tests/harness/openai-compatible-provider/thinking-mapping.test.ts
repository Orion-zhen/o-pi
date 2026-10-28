import { expect, it } from "vitest";
import { parseModelsDocument } from "../../../src/harness/openai-compatible-provider/document.ts";
import { editModelsDocument } from "../../../src/harness/openai-compatible-provider/config-edits.ts";
import { configuredModels } from "../../../src/harness/openai-compatible-provider/model-settings.ts";
import { modelSettingsView } from "../../../src/harness/openai-compatible-provider/settings-view.ts";

const provider = { api: "openai-responses" };
const model = { id: "m", reasoning: true };

it("编辑、禁用和还原映射只影响目标等级，服务商 max 不启用 opi 的 max", () => {
	let content = JSON.stringify({ providers: { local: { ...provider, models: [model] } } });
	const path = ["providers", "local", "models", 0, "thinkingLevelMap"];
	const rows = () => {
		const local = parseModelsDocument(content).providers.local;
		if (!local) throw new Error("缺少服务");
		const entry = configuredModels(local)[0];
		if (!entry) throw new Error("缺少模型");
		return modelSettingsView("local", local, entry).thinking.rows;
	};
	expect(rows().filter((row) => row.available).map((row) => row.level)).toEqual(["off", "minimal", "low", "medium", "high"]);
	expect(rows().find((row) => row.level === "off")).toMatchObject({ defaultValue: "none", value: "", modified: false });
	content = editModelsDocument(content, [...path, "xhigh"], "max");
	content = editModelsDocument(content, [...path, "minimal"], null);
	expect(rows().find((row) => row.level === "xhigh")).toMatchObject({ available: true, value: "max", modified: true });
	expect(rows().find((row) => row.level === "max")).toMatchObject({ available: false });
	expect(rows().find((row) => row.level === "minimal")).toMatchObject({ available: false, enableValue: undefined });
	content = editModelsDocument(content, [...path, "minimal"], undefined);
	expect(rows().find((row) => row.level === "minimal")).toMatchObject({ available: true, modified: false });
	expect(rows().find((row) => row.level === "xhigh")).toMatchObject({ value: "max" });
	content = editModelsDocument(content, path, undefined);
	expect(rows().find((row) => row.level === "xhigh")).toMatchObject({ available: false });
});

it("模型覆盖继承原始映射，编辑定义本身不把旧值当作默认", () => {
	const models = [{ ...model, thinkingLevelMap: { high: "max", minimal: null } }];
	const entry = configuredModels({ ...provider, models, modelOverrides: { m: { thinkingLevelMap: { high: "custom" } } } })[0];
	if (!entry) throw new Error("缺少模型");
	const mapping = modelSettingsView("local", provider, entry).thinking;
	expect(mapping.rows.find((row) => row.level === "high")).toMatchObject({ value: "custom", defaultValue: "max" });
	expect(mapping.rows.find((row) => row.level === "minimal")).toMatchObject({ available: false, modified: false, enableValue: "minimal" });
	const reset = modelSettingsView("local", provider, { ...entry, configured: {} }).thinking;
	expect(reset.rows.find((row) => row.level === "high")).toMatchObject({ value: "", defaultValue: "max", modified: false });
	expect(configuredModels({ models })[0]?.defaults).toEqual({});
});

it("非推理模型运行时只有 off，仍保留重新开启能力后的等级状态", () => {
	const mapping = modelSettingsView("local", provider, { id: "m", defaults: {}, configured: {} }).thinking;
	expect(mapping.rows.filter((row) => row.available).map((row) => row.level)).toEqual(["off"]);
	expect(mapping.rows.filter((row) => row.enabled).map((row) => row.level)).toEqual(["off", "minimal", "low", "medium", "high"]);
});

it("映射展示遵循原生格式及检测结果", () => {
	const local = { api: "openai-completions", baseUrl: "https://api.deepseek.com/v1" };
	const off = (configured: Record<string, unknown>) => modelSettingsView("local", local, { id: "m", defaults: model, configured }).thinking.rows[0];
	expect(off({ compat: { thinkingFormat: "openrouter" } })).toMatchObject({ defaultValue: "none", mapsEffort: true });
	expect(off({})).toMatchObject({ defaultValue: undefined, mapsEffort: false });
	expect(off({ compat: { thinkingFormat: "chat-template", chatTemplateKwargs: { effort: { $var: "thinking.effort" } } } }))
		.toMatchObject({ defaultValue: undefined, mapsEffort: true });
});

it("手动改回默认映射不再显示重置，但新增可用等级仍算覆盖", () => {
	const mapping = modelSettingsView("local", provider, { id: "m", defaults: {}, configured: { ...model, thinkingLevelMap: { high: "high", off: "none", xhigh: "xhigh", max: null } } }).thinking;
	for (const level of ["high", "off", "max"]) expect(mapping.rows.find((row) => row.level === level)?.modified).toBe(false);
	expect(mapping.rows.find((row) => row.level === "xhigh")).toMatchObject({ enabled: true, modified: true });
	const inherited = modelSettingsView("local", provider, { id: "m", defaults: { thinkingLevelMap: { high: "custom", low: null } },
		configured: { thinkingLevelMap: { high: "custom", low: null } } }).thinking;
	expect(inherited.modified).toBe(false);
});

it("思考映射与兼容设置共用协议和地址默认值", () => {
	const completions = { api: "openai-completions" };
	expect(modelSettingsView("local", completions, { id: "m", defaults: {}, configured: model }).thinking.rows[0]).toMatchObject({ defaultValue: undefined, mapsEffort: true });
	expect(modelSettingsView("local", { ...completions, baseUrl: "https://openrouter.ai/api/v1" }, { id: "m", defaults: {}, configured: model }).thinking.rows[0])
		.toMatchObject({ defaultValue: "none" });
	expect(modelSettingsView("local", { ...completions, baseUrl: "https://api.deepseek.com/v1" }, { id: "m", defaults: {}, configured: model }).thinking.rows[0])
		.toMatchObject({ defaultValue: undefined, mapsEffort: false });
});

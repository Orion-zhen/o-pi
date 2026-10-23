import { expect, it } from "vitest";
import { modelCandidates, modelCandidateEdits, type ModelCandidate } from "../../src/harness/openai-compatible-provider/model-candidates.ts";
import { configuredModels } from "../../src/harness/openai-compatible-provider/model-settings.ts";
import { completeProviderModels, editProviderField } from "../../src/harness/openai-compatible-provider/config-edits.ts";
import { receiveServiceCandidates } from "../../src/gui/frontend/features/models/services/service-draft.ts";
import { parseModelsDocument, type ConfigObject } from "../../src/harness/openai-compatible-provider/document.ts";
import { modelSettingsView } from "../../src/harness/openai-compatible-provider/settings-view.ts";

const id = "qwen3.8-flash-next";
const candidates = [id, `${id}:low`, `${id}:medium`, `${id}:xhigh`].map((id) => ({ id }));
const provider = { api: "openai-completions", thinkingPreset: "model-suffix", models: [{ id }] };
const expectedMap = { minimal: null, low: "low", medium: "medium", high: null, xhigh: "xhigh", max: null };
function materialize(provider: ConfigObject, candidates: ModelCandidate[]) {
	const content = completeProviderModels(JSON.stringify({ providers: { local: provider } }), "local", candidates);
	const next = parseModelsDocument(content).providers.local;
	if (!next) throw new Error("缺少服务");
	return next;
}

it("按真实后缀生成候选与已选模型映射，不虚构 minimal/high，自动启用 xhigh", () => {
	const catalog = modelCandidates(provider, candidates);
	expect(catalog).toEqual([{ id, reasoning: true, thinkingLevelMap: expectedMap }]);
	const next = materialize(provider, candidates);
	expect(next.models).toEqual([{ id, reasoning: true, thinkingLevelMap: expectedMap }]);
	const model = configuredModels(next, catalog)[0];
	if (!model) throw new Error("缺少模型");
	const mapping = modelSettingsView("local", next, model).thinking;
	expect(mapping.rows.filter((row) => row.available).map(({ level, targetModel }) => [level, targetModel])).toEqual([
		["off", id], ["low", `${id}:low`], ["medium", `${id}:medium`], ["xhigh", `${id}:xhigh`],
	]);
	expect(mapping.modified).toBe(false);
	expect(modelCandidateEdits(next, candidates)).toEqual([]);
	expect(provider.models).toEqual([{ id }]);
});

it("off 变体、缺少裸模型和未知后缀均按实际 ID 处理", () => {
	const raw = [{ id: "m:32b:xhigh", contextWindow: 32768 }, { id: "m:32b:off" }, { id: "other:latest" }];
	expect(modelCandidates(provider, raw)).toEqual([
		{ id: "m:32b", contextWindow: 32768, reasoning: true, thinkingLevelMap: { ...expectedMap, low: null, medium: null, off: "off" } },
		{ id: "other:latest", reasoning: false, thinkingLevelMap: { ...expectedMap, low: null, medium: null, xhigh: null } },
	]);
	expect(modelCandidates(provider, [{ id: "m:max" }])[0])
		.toMatchObject({ id: "m", reasoning: true, thinkingLevelMap: { off: null, high: null, max: "max" } });
});

it("普通模式不折叠，模型和覆盖层的预设优先于服务预设", () => {
	expect(modelCandidates({}, candidates)).toEqual(candidates);
	const configured = { ...provider, modelOverrides: { [id]: { thinkingPreset: "openai" } } };
	expect(modelCandidates(configured, candidates)).toEqual(candidates);
	expect(modelCandidates({ models: [{ id, thinkingPreset: "model-suffix" }] }, candidates)).toHaveLength(1);
});

it("补全已有模型和覆盖层但保留手动设置，不自动注册候选", () => {
	const configured = { ...provider, models: [{ id, reasoning: true, name: "Qwen", thinkingLevelMap: { low: null } }],
		modelOverrides: { [id]: { thinkingLevelMap: { xhigh: null } } } };
	const next = materialize(configured, candidates);
	expect(next.models).toEqual(configured.models);
	expect(next.modelOverrides).toEqual({ [id]: { reasoning: true, thinkingLevelMap: { ...expectedMap, low: null, xhigh: null } } });
	expect(modelCandidateEdits({ thinkingPreset: "model-suffix" }, candidates)).toEqual([]);
	expect(modelCandidateEdits(provider, [])).toEqual([]);
});

it("批量补全保留注释、其他服务和显式关闭的思考能力", () => {
	const configured = { ...provider, models: [{ id, reasoning: false }] };
	const original = '{"providers":{"local":' + JSON.stringify(configured) + ',\n// 其他服务\n"other":{"custom":true}}}';
	const content = completeProviderModels(original, "local", candidates);
	expect(content).toContain("// 其他服务");
	expect(parseModelsDocument(content).providers).toMatchObject({
		local: { models: [{ id, reasoning: false, thinkingLevelMap: expectedMap }] }, other: { custom: true },
	});
});

it("一次编辑切换后缀模式并完成补全，恢复默认不依赖后续渲染", () => {
	const original = JSON.stringify({ providers: { local: { api: provider.api, models: [{ id }] } } });
	const content = editProviderField(original, "local", ["thinkingPreset"], "model-suffix", candidates);
	const disabled = editProviderField(content, "local", ["models", 0, "thinkingLevelMap", "xhigh"], null, candidates);
	const reset = editProviderField(disabled, "local", ["models", 0, "thinkingLevelMap"], undefined, candidates);
	expect(parseModelsDocument(reset)).toEqual(parseModelsDocument(content));
});

it("候选到达时保留未完成的 JSON，不复活已删除的服务", () => {
	for (const content of ['{"providers":', '{"providers":{}}']) {
		expect(receiveServiceCandidates(content, "local", candidates)).toBe(content);
	}
});

it("候选到达时基于最新草稿补全，不覆盖等待期间的手动设置", () => {
	const original = JSON.stringify({ providers: { local: provider } });
	let draft = editProviderField(original, "local", ["models", 0, "name"], "手动名称", []);
	draft = editProviderField(draft, "local", ["models", 0, "reasoning"], false, []);
	draft = editProviderField(draft, "local", ["models", 0, "thinkingLevelMap", "xhigh"], null, []);
	const completed = receiveServiceCandidates(draft, "local", candidates);
	expect(parseModelsDocument(completed).providers.local).toMatchObject({ models: [{
		id, name: "手动名称", reasoning: false, thinkingLevelMap: { ...expectedMap, xhigh: null },
	}] });
});

it("显式字段编辑拒绝非法文档，不沿用异步候选的忽略策略", () => {
	expect(() => editProviderField('{"providers":', "local", ["name"], "新名称", candidates)).toThrow();
});

it("没有候选或映射时，后缀设置遵循 SDK 的通用等级，不另加限制", () => {
	const mapping = modelSettingsView("local", provider, { id, defaults: {}, configured: { reasoning: true } }).thinking;
	expect(mapping.rows.filter((row) => row.available).map(({ level }) => level)).toEqual(["off", "minimal", "low", "medium", "high"]);
});

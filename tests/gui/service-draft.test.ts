import { expect, it } from "vitest";
import { editModelsDocument } from "../../src/harness/openai-compatible-provider/config-edits.ts";
import { serviceDraftChanged } from "../../src/gui/frontend/features/models/services/service-draft.ts";

const provider = { api: "openai-completions", baseUrl: "http://localhost/v1", models: [{ id: "m" }] };
const document = (value: Record<string, unknown> = provider) => JSON.stringify({ providers: { local: value } });
const edit = (content: string, path: (string | number)[], value: unknown) => editModelsDocument(content, ["providers", "local", ...path], value);

it("改回原值或移除新增设置后不再需要保存，忽略表单编辑造成的格式和键顺序差异", () => {
	const original = document({ ...provider, name: "本地", maxRetries: 2 });
	const changed = edit(original, ["name"], "其他");
	expect(serviceDraftChanged(original, changed)).toBe(true);
	expect(serviceDraftChanged(original, edit(changed, ["name"], "本地"))).toBe(false);
	const removed = edit(original, ["name"], undefined);
	expect(serviceDraftChanged(original, edit(removed, ["name"], "本地"))).toBe(false);
	const added = edit(original, ["compat", "supportsStore"], false);
	expect(serviceDraftChanged(original, added)).toBe(true);
	expect(serviceDraftChanged(original, edit(added, ["compat", "supportsStore"], undefined))).toBe(false);
});

it("显式默认值和未配置等价，但不同默认值仍算修改", () => {
	const original = document();
	for (const [path, value] of [
		[["authHeader"], false], [["thinkingPreset"], "auto"], [["compat", "supportsStore"], true],
		[["models", 0, "contextWindow"], 128000], [["models", 0, "reasoning"], false],
		[["models", 0, "input"], ["text"]], [["models", 0, "name"], "m"],
	] as const) expect(serviceDraftChanged(original, edit(original, [...path], value))).toBe(false);
	expect(serviceDraftChanged(original, edit(original, ["authHeader"], true))).toBe(true);
	expect(serviceDraftChanged(original, edit(original, ["models", 0, "maxTokens"], 16384))).toBe(true);
	const explicit = edit(original, ["authHeader"], false);
	expect(serviceDraftChanged(explicit, edit(explicit, ["authHeader"], undefined))).toBe(false);
});

it("模型覆盖按模型定义和服务识别默认值，保留动态默认值变化", () => {
	const original = document({ ...provider, baseUrl: "https://api.deepseek.com/v1",
		models: [{ id: "m", maxTokens: 8192, samplingParams: { temperature: 0.5 } }], modelOverrides: { m: {} } });
	for (const [path, value] of [
		[["maxTokens"], 8192], [["samplingParams", "temperature"], 0.5], [["compat", "maxTokensField"], "max_tokens"],
	] as const) expect(serviceDraftChanged(original, edit(original, ["modelOverrides", "m", ...path], value))).toBe(false);
	expect(serviceDraftChanged(original, edit(original, ["modelOverrides", "m", "maxTokens"], 4096))).toBe(true);
	expect(serviceDraftChanged(original, edit(original, ["baseUrl"], "http://localhost/v1"))).toBe(true);
	const mixed = document({ ...provider, baseUrl: "https://openrouter.ai/api/v1", models: [{ id: "openai/m" }, { id: "other/m" }] });
	for (const value of [false, true]) expect(serviceDraftChanged(mixed, edit(mixed, ["compat", "supportsDeveloperRole"], value))).toBe(true);
});

it("思考映射改回协议默认值无需保存，但新增等级和禁用已有等级仍需保存", () => {
	const original = document({ ...provider, api: "openai-responses", models: [{ id: "m", reasoning: true }] });
	const path = ["models", 0, "thinkingLevelMap"];
	const changed = edit(original, [...path, "high"], "custom");
	expect(serviceDraftChanged(original, changed)).toBe(true);
	expect(serviceDraftChanged(original, edit(changed, [...path, "high"], "high"))).toBe(false);
	expect(serviceDraftChanged(original, edit(original, [...path, "high"], null))).toBe(true);
	expect(serviceDraftChanged(original, edit(original, [...path, "xhigh"], "xhigh"))).toBe(true);
});

it("增删服务和模型回到原状无需保存，空容器不制造修改", () => {
	const added = editModelsDocument("", ["providers", "local"], provider);
	expect(serviceDraftChanged("", added)).toBe(true);
	expect(serviceDraftChanged("", editModelsDocument(added, ["providers", "local"], undefined))).toBe(false);
	const original = document({ api: "openai-completions", baseUrl: "http://localhost/v1" });
	const model = edit(original, ["models", 0], { id: "m" });
	expect(serviceDraftChanged(original, model)).toBe(true);
	expect(serviceDraftChanged(original, edit(model, ["models", 0], undefined))).toBe(false);
});

it("非法 JSON、未知字段和原生服务的修改不会被默认值比较吞掉", () => {
	const original = document();
	expect(serviceDraftChanged(original, "{")).toBe(true);
	expect(serviceDraftChanged("{", original)).toBe(true);
	expect(serviceDraftChanged(original, edit(original, ["extraBody"], { payload: {} }))).toBe(true);
	const native = '{"providers":{"anthropic":{"apiKey":"$KEY"}}}';
	expect(serviceDraftChanged(native, editModelsDocument(native, ["providers", "anthropic", "apiKey"], "$OTHER"))).toBe(true);
});

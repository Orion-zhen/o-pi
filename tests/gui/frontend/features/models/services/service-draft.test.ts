import { expect, it } from "vitest";
import { editModelsDocument } from "../../../../../../src/harness/openai-compatible-provider/config-edits.ts";
import { emptyModelsDocument } from "../../../../../../src/harness/openai-compatible-provider/document.ts";
import { parseServiceDraft, serviceDraftChanged } from "../../../../../../src/gui/frontend/features/models/services/service-draft.ts";

const changed = (before: string, after: string) => serviceDraftChanged(
	parseServiceDraft(before || emptyModelsDocument).value, parseServiceDraft(after || emptyModelsDocument).value,
);

const provider = { api: "openai-completions", baseUrl: "http://localhost/v1", models: [{ id: "m" }] };
const document = (value: Record<string, unknown> = provider) => JSON.stringify({ providers: { local: value } });
const edit = (content: string, path: (string | number)[], value: unknown) => editModelsDocument(content, ["providers", "local", ...path], value);

it("改回原值或移除新增设置后不再需要保存，忽略表单编辑造成的格式和键顺序差异", () => {
	const original = document({ ...provider, name: "本地", maxRetries: 2 });
	const edited = edit(original, ["name"], "其他");
	expect(changed(original, edited)).toBe(true);
	expect(changed(original, edit(edited, ["name"], "本地"))).toBe(false);
	const removed = edit(original, ["name"], undefined);
	expect(changed(original, edit(removed, ["name"], "本地"))).toBe(false);
	const added = edit(original, ["compat", "supportsStore"], false);
	expect(changed(original, added)).toBe(true);
	expect(changed(original, edit(added, ["compat", "supportsStore"], undefined))).toBe(false);
});

it("显式默认值和未配置等价，但不同默认值仍算修改", () => {
	const original = document();
	for (const [path, value] of [
		[["authHeader"], false], [["compat", "thinkingFormat"], "openai"], [["compat", "supportsStore"], true],
		[["models", 0, "contextWindow"], 128000], [["models", 0, "reasoning"], false],
		[["models", 0, "input"], ["text"]], [["models", 0, "name"], "m"],
	] as const) expect(changed(original, edit(original, [...path], value))).toBe(false);
	expect(changed(original, edit(original, ["authHeader"], true))).toBe(true);
	expect(changed(original, edit(original, ["models", 0, "maxTokens"], 16384))).toBe(true);
	const explicit = edit(original, ["authHeader"], false);
	expect(changed(explicit, edit(explicit, ["authHeader"], undefined))).toBe(false);
});

it("模型覆盖按模型定义和服务识别默认值，保留动态默认值变化", () => {
	const original = document({ ...provider, baseUrl: "https://api.deepseek.com/v1",
		models: [{ id: "m", maxTokens: 8192, samplingParams: { temperature: 0.5 } }], modelOverrides: { m: {} } });
	for (const [path, value] of [
		[["maxTokens"], 8192], [["samplingParams", "temperature"], 0.5], [["compat", "maxTokensField"], "max_tokens"],
	] as const) expect(changed(original, edit(original, ["modelOverrides", "m", ...path], value))).toBe(false);
	expect(changed(original, edit(original, ["modelOverrides", "m", "maxTokens"], 4096))).toBe(true);
	expect(changed(original, edit(original, ["baseUrl"], "http://localhost/v1"))).toBe(true);
	const mixed = document({ ...provider, baseUrl: "https://openrouter.ai/api/v1", models: [{ id: "openai/m" }, { id: "other/m" }] });
	for (const value of [false, true]) expect(changed(mixed, edit(mixed, ["compat", "supportsDeveloperRole"], value))).toBe(true);
});

it.each(["chatTemplateKwargs", "chatTemplateArgs"])("%s 按参数名继承，变量对象整体替换，取消省略后仍需保存", (key) => {
	const inherited = { enabled: { $var: "thinking.enabled", omitWhenOff: true }, keep: "inherited" };
	const original = document({ ...provider, compat: { [key]: inherited },
		models: [{ id: "m", reasoning: true, compat: { [key]: inherited } }], modelOverrides: { m: {} } });
	for (const scope of [["models", 0], ["modelOverrides", "m"]]) {
		const path = [...scope, "compat", key, "enabled"];
		const edited = edit(original, path, { $var: "thinking.enabled" });
		expect(changed(original, edited)).toBe(true);
		expect(changed(original, edit(edited, path, inherited.enabled))).toBe(false);
		expect(changed(original, edit(edited, path, undefined))).toBe(false);
	}
});

it("只按已知继承层级比较，不递归消除参数值或未知对象中的差异", () => {
	const original = document({ ...provider, models: [{ id: "m", samplingParams: { custom: { keep: true, remove: true } },
		custom: { keep: true, remove: true } }], modelOverrides: { m: {} } });
	for (const path of [["samplingParams", "custom"], ["custom"]]) {
		expect(changed(original, edit(original, ["modelOverrides", "m", ...path], { keep: true }))).toBe(true);
	}
});

it("思考映射改回协议默认值无需保存，但新增等级和禁用已有等级仍需保存", () => {
	const original = document({ ...provider, api: "openai-responses", models: [{ id: "m", reasoning: true }] });
	const path = ["models", 0, "thinkingLevelMap"];
	const edited = edit(original, [...path, "high"], "custom");
	expect(changed(original, edited)).toBe(true);
	expect(changed(original, edit(edited, [...path, "high"], "high"))).toBe(false);
	expect(changed(original, edit(original, [...path, "high"], null))).toBe(true);
	expect(changed(original, edit(original, [...path, "xhigh"], "xhigh"))).toBe(true);
});

it.each(["anthropic-messages", "unknown-api"])("%s 的显式配置不会被当作 OpenAI 默认值忽略", (api) => {
	for (const scope of [["models", 0], ["modelOverrides", "m"]]) {
		const original = document({ ...provider, models: [{ id: "m", api, reasoning: true }], modelOverrides: { m: {} } });
		for (const [path, value] of [
			[["compat", "supportsDeveloperRole"], true], [["thinkingLevelMap", "off"], "none"], [["thinkingLevelMap", "high"], "high"],
		] as const) expect(changed(original, edit(original, [...scope, ...path], value))).toBe(true);
	}
});

it("增删服务和模型回到原状无需保存，空容器不制造修改", () => {
	const added = editModelsDocument("", ["providers", "local"], provider);
	expect(changed("", added)).toBe(true);
	expect(changed("", editModelsDocument(added, ["providers", "local"], undefined))).toBe(false);
	const original = document({ api: "openai-completions", baseUrl: "http://localhost/v1" });
	const model = edit(original, ["models", 0], { id: "m" });
	expect(changed(original, model)).toBe(true);
	expect(changed(original, edit(model, ["models", 0], undefined))).toBe(false);
});

it("非法 JSON、未知字段和原生服务的修改不会被默认值比较吞掉", () => {
	const original = document();
	expect(changed(original, "{")).toBe(true);
	expect(changed("{", original)).toBe(true);
	expect(changed(original, edit(original, ["extraBody"], { payload: {} }))).toBe(true);
	const native = '{"providers":{"anthropic":{"apiKey":"$KEY"}}}';
	expect(changed(native, editModelsDocument(native, ["providers", "anthropic", "apiKey"], "$OTHER"))).toBe(true);
});

import { expect, it } from "vitest";
import { serviceCompatSettings } from "../../../src/harness/model-services/compat-settings.ts";
import { configuredModels } from "../../../src/harness/model-services/model-settings.ts";
import { modelSettingsView } from "../../../src/harness/model-services/settings-view.ts";
import { capturePayload, loadProvider, providerConfig } from "./fixtures.ts";
import { useModelServicesTestSetup } from "./test-support.ts";

const temp = useModelServicesTestSetup();
const model = { id: "m", reasoning: true, thinkingLevelMap: { high: "medium", off: "none" } };

it.each([
	{ format: "openai", effort: true, field: "reasoning_effort", off: true },
	{ format: "openrouter", effort: false, field: "reasoning.effort", off: true },
	{ format: "deepseek", effort: true, field: "reasoning_effort", off: false },
	{ format: "together", effort: true, field: "reasoning_effort", off: false },
	{ format: "zai", effort: true, field: "reasoning_effort", off: false },
	{ format: "qwen", effort: true, field: "reasoning_effort", off: false },
	{ format: "string-thinking", effort: false, field: "thinking", off: true },
	{ format: "ant-ling", effort: false, field: "reasoning.effort", off: false },
])("配置 $format 后，设置页映射与实际开关思考请求一致", async ({ format, effort, field, off }) => {
	const provider = providerConfig({ compat: { thinkingFormat: format, supportsReasoningEffort: effort }, models: [model] });
	const fixture = await loadProvider(temp.path, provider);
	const entry = configuredModels(provider)[0];
	if (!entry) throw new Error("缺少模型");
	const { thinking } = modelSettingsView("gateway", provider, entry);
	expect(thinking.rows.find((row) => row.level === "high")?.mapsEffort).toBe(true);
	expect(await capturePayload(fixture, { reasoning: "high" })).toHaveProperty(field, "medium");
	expect(thinking.rows.find((row) => row.level === "off")?.mapsEffort).toBe(off);
	const payload = await capturePayload(fixture);
	if (off) expect(payload).toHaveProperty(field, "none");
	else expect(payload).not.toHaveProperty(field);
});

it.each([
	{ thinkingFormat: "chat-template", key: "chatTemplateKwargs", field: "chat_template_kwargs" },
	{ thinkingFormat: "baseten", key: "chatTemplateArgs", field: "chat_template_args" },
])("$thinkingFormat 继承模板参数，关闭思考时省略 effort", async ({ thinkingFormat, key, field }) => {
	const provider = providerConfig({
		compat: { thinkingFormat, supportsReasoningEffort: false, [key]: { enabled: { $var: "thinking.enabled" } } },
		models: [{ ...model, compat: { [key]: { effort: { $var: "thinking.effort", omitWhenOff: true } } } }],
		modelOverrides: { m: { compat: { [key]: { custom: "kept" } } } },
	});
	const fixture = await loadProvider(temp.path, provider);
	const entry = configuredModels(provider)[0];
	if (!entry) throw new Error("缺少模型");
	const { thinking } = modelSettingsView("gateway", provider, entry);
	expect(thinking.rows.find((row) => row.level === "high")?.mapsEffort).toBe(true);
	expect(thinking.rows.find((row) => row.level === "off")?.mapsEffort).toBe(false);
	expect(await capturePayload(fixture, { reasoning: "high" })).toHaveProperty(field, { enabled: true, effort: "medium", custom: "kept" });
	expect(await capturePayload(fixture)).toHaveProperty(field, { enabled: false, custom: "kept" });
});

it("按地址识别 Together，模型覆盖格式后开放等级映射", async () => {
	const provider = providerConfig({ baseUrl: "https://api.together.xyz/v1", models: [model] });
	const inherited = await loadProvider(temp.path, provider);
	const view = modelSettingsView("gateway", provider, { id: "m", defaults: {}, configured: model });
	expect(view.thinking.rows.every((row) => !row.mapsEffort)).toBe(true);
	const payload = await capturePayload(inherited, { reasoning: "high" });
	expect(payload).toMatchObject({ reasoning: { enabled: true } });
	expect(payload).not.toHaveProperty("reasoning_effort");
	const overridden = { ...provider, modelOverrides: { m: { compat: {
		thinkingFormat: "chat-template", chatTemplateKwargs: { effort: { $var: "thinking.effort" } },
	} } } };
	const fixture = await loadProvider(temp.path, overridden);
	const entry = configuredModels(overridden)[0];
	if (!entry) throw new Error("缺少模型");
	expect(modelSettingsView("gateway", overridden, entry).thinking.rows.find((row) => row.level === "high")?.mapsEffort).toBe(true);
	expect(await capturePayload(fixture, { reasoning: "high" })).toHaveProperty("chat_template_kwargs.effort", "medium");
});

it.each(["gateway", "github-copilot"])("%s Responses 的显示默认值与实际请求一致", async (id) => {
	const provider = providerConfig({ api: "openai-responses", models: [{ id: "m", reasoning: true }] }, id);
	const fixture = await loadProvider(temp.path, provider, id);
	const { thinking } = modelSettingsView(id, provider, { id: "m", defaults: {}, configured: { reasoning: true } });
	expect(serviceCompatSettings(id, provider).capabilities?.effortControl).toBe("unused");
	expect(thinking.rows.find((row) => row.level === "high")).toMatchObject({ mapsEffort: true, defaultValue: "high" });
	expect(await capturePayload(fixture, { reasoning: "high" })).toHaveProperty("reasoning.effort", "high");
	const off = thinking.rows.find((row) => row.level === "off");
	const payload = await capturePayload(fixture);
	if (id === "github-copilot") {
		expect(off?.mapsEffort).toBe(false);
		expect(payload).not.toHaveProperty("reasoning.effort");
	} else {
		expect(off).toMatchObject({ mapsEffort: true, defaultValue: "none" });
		expect(payload).toHaveProperty("reasoning.effort", "none");
	}
});

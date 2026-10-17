import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { completeProviderModels } from "../../src/harness/openai-compatible-provider/config-edits.ts";
import { parseModelsDocument } from "../../src/harness/openai-compatible-provider/document.ts";
import { modelSettingsView } from "../../src/harness/openai-compatible-provider/settings-view.ts";
import { capturePayload, loadProvider } from "../harness/openai-compatible-provider/fixtures.ts";
import { useOpenAICompatibleProviderTestSetup } from "../harness/openai-compatible-provider/test-support.ts";

const temp = useOpenAICompatibleProviderTestSetup();
it.each(["openai-completions", "openai-responses"] as const)("%s 保存自动后缀映射后，SDK 可选等级及请求 ID 均来自实际候选", async (api) => {
	const provider = { api, thinkingPreset: "model-suffix", models: [{ id: "m" }] };
	const candidates = ["m", "m:low", "m:medium", "m:xhigh"].map((id) => ({ id }));
	const content = completeProviderModels(JSON.stringify({ providers: { local: provider } }), "local", candidates);
	const saved = parseModelsDocument(content).providers.local;
	if (!saved) throw new Error("缺少服务");
	const fixture = await loadProvider(temp.path, saved);
	const model = fixture.runtime.getModel("gateway", "m");
	if (!model) throw new Error("缺少模型");
	expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "medium", "xhigh"]);
	for (const level of ["off", "low", "medium", "xhigh"] as const) {
		expect(await capturePayload(fixture, level === "off" ? {} : { reasoning: level }))
			.toHaveProperty("model", level === "off" ? "m" : `m:${level}`);
	}
	for (const level of ["minimal", "high", "max"] as const) {
		const payload = await capturePayload(fixture, { reasoning: level });
		expect(payload).toHaveProperty("model", level === "minimal" ? "m:low" : "m:xhigh");
	}
});

it.each(["openai-completions", "openai-responses"] as const)("%s 无候选时设置页能力与 SDK 及实际后缀路由一致", async (api) => {
	const configured = { id: "m", reasoning: true };
	const provider = { api, thinkingPreset: "model-suffix", models: [configured] };
	const fixture = await loadProvider(temp.path, provider);
	const model = fixture.runtime.getModel("gateway", "m");
	if (!model) throw new Error("缺少模型");
	const settings = modelSettingsView("gateway", provider, { id: "m", defaults: {}, configured }).thinking;
	expect(settings.rows.filter((row) => row.available).map(({ level }) => level)).toEqual(getSupportedThinkingLevels(model));
	for (const row of settings.rows.filter((row) => row.available)) {
		expect(await capturePayload(fixture, row.level === "off" ? {} : { reasoning: row.level })).toHaveProperty("model", row.targetModel);
	}
});

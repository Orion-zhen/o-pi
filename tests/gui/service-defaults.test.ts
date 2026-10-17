import type { Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, expect, it, vi } from "vitest";
import { detectedServiceCompat, serviceCompatDefaults } from "../../src/harness/openai-compatible-provider/compat-defaults.ts";
import { configuredModels } from "../../src/harness/openai-compatible-provider/model-settings.ts";
import { comparableModelsDocument, modelSettingsView } from "../../src/harness/openai-compatible-provider/settings-view.ts";

afterEach(() => vi.restoreAllMocks());

it.each([
	["local", "http://localhost:8080/v1", "m"],
	["local", "https://api.deepseek.com/v1", "m"],
	["deepseek", "https://proxy.test/v1", "m"],
	["zai-coding-cn", "https://proxy.test/v1", "m"],
	["local", "https://open.bigmodel.cn/api/paas/v4", "m"],
	["local", "https://api.together.xyz/v1", "m"],
	["moonshotai", "https://proxy.test/v1", "m"],
	["local", "https://api.moonshot.cn/v1", "m"],
	["local", "https://integrate.api.nvidia.com/v1", "m"],
	["cerebras", "https://proxy.test/v1", "m"],
	["xai", "https://proxy.test/v1", "m"],
	["local", "https://chutes.ai/v1", "m"],
	["opencode", "https://proxy.test/v1", "m"],
	["cloudflare-workers-ai", "https://proxy.test/v1", "m"],
	["local", "https://gateway.ai.cloudflare.com/v1", "m"],
	["ant-ling", "https://proxy.test/v1", "m"],
	["local", "https://openrouter.ai/api/v1", "openai/m"],
	["openrouter", "https://proxy.test/v1", "anthropic/m"],
	["openrouter", "https://proxy.test/v1", "other/m"],
])("%s %s %s 的展示值与 SDK 实际请求一致", async (provider, baseUrl, id) => {
	const model: Model<"openai-completions"> = {
		provider, baseUrl, id, name: id, api: "openai-completions", reasoning: true, input: ["text"],
		contextWindow: 128000, maxTokens: 16384, thinkingLevelMap: { high: "high" },
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const { supportsDeveloperRole, ...detected } = detectedServiceCompat(provider, baseUrl, id);
	if (supportsDeveloperRole === undefined) throw new Error("模型默认值未解析");
	const compat: OpenAICompletionsCompat = { ...detected, supportsDeveloperRole };
	const requests: unknown[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		requests.push(JSON.parse(String(init?.body)));
		return new Response('{"error":"stop"}', { status: 400 });
	});
	for (const current of [model, { ...model, compat }]) {
		for await (const _event of streamSimple(current, normalizeContext({ systemPrompt: "system", messages: [{ role: "user", content: "hello", timestamp: 0 }] }), {
			apiKey: "test", reasoning: "high", maxTokens: 512,
		})) {}
	}
	expect(requests).toHaveLength(2);
	expect(requests[1]).toEqual(requests[0]);
});

it("模型字段按服务、模型定义继承，但不把自身覆盖当成重置值", () => {
	const provider = { api: "openai-completions", baseUrl: "https://api.deepseek.com/v1", thinkingPreset: "model-suffix",
		compat: { supportsStore: true } };
	const defaults = serviceCompatDefaults("local", provider, { id: "m",
		defaults: { thinkingPreset: "qwen", compat: { supportsStore: false } }, configured: { thinkingPreset: "openai" },
	});
	expect(defaults).toMatchObject({ thinkingPreset: "qwen", compat: { thinkingFormat: "deepseek", supportsStore: false, maxTokensField: "max_tokens" } });
	expect(serviceCompatDefaults("local", provider).compat).toMatchObject({ thinkingFormat: "deepseek", supportsStore: false });
});

it("修改模型地址或协议立即重新解析默认值", () => {
	const provider = { api: "openai-completions", baseUrl: "https://api.deepseek.com/v1" };
	expect(serviceCompatDefaults("local", provider, { id: "m", defaults: {}, configured: { baseUrl: "http://localhost/v1" } }).compat)
		.toMatchObject({ thinkingFormat: "openai", maxTokensField: "max_completion_tokens", supportsDeveloperRole: true });
	expect(serviceCompatDefaults("local", provider, { id: "m", defaults: {}, configured: { api: "openai-responses" } }))
		.toEqual({ api: "openai-responses", thinkingPreset: "auto", compat: { supportsDeveloperRole: true } });
});

it("展示与比较共用继承规则，不清洗显式值或未知字段", () => {
	const provider = {
		api: "openai-completions", baseUrl: "https://api.deepseek.com/v1", custom: { keep: true },
		models: [{ id: "m", maxTokens: 8192, reasoning: true, thinkingLevelMap: { high: "custom" } }],
		modelOverrides: { m: { maxTokens: 8192, thinkingLevelMap: { high: "custom" }, extra: { keep: true } } },
	};
	const document = { providers: { local: provider } };
	const original = JSON.stringify(document);
	const model = configuredModels(provider)[0];
	if (!model) throw new Error("缺少模型");
	const view = modelSettingsView("local", provider, model);
	expect(view.defaults.maxTokens).toBe(8192);
	expect(view.compat.compat.maxTokensField).toBe("max_tokens");
	expect(view.thinking.rows.find((row) => row.level === "high")).toMatchObject({ defaultValue: "custom", modified: false });
	expect(view.overrides).toEqual({ extra: { keep: true } });
	expect(JSON.parse(comparableModelsDocument(document))).toMatchObject({ providers: { local: {
		custom: { keep: true }, modelOverrides: { m: { extra: { keep: true } } },
	} } });
	expect(JSON.stringify(document)).toBe(original);
});

it("服务级模型默认值不一致时不伪造布尔值，模型内显示具体值", () => {
	const provider = { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", models: [{ id: "openai/m" }, { id: "other/m" }] };
	expect(serviceCompatDefaults("local", provider).compat.supportsDeveloperRole).toBeUndefined();
	for (const id of ["openai/m", "other/m"]) {
		expect(serviceCompatDefaults("local", provider, { id, defaults: {}, configured: {} }).compat.supportsDeveloperRole).toBe(id === "openai/m");
	}
	expect(serviceCompatDefaults("local", { ...provider, models: [{ id: "openai/m" }] }).compat.supportsDeveloperRole).toBe(true);
});

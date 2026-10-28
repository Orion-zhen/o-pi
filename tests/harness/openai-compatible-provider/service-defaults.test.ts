import type { Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, expect, it, vi } from "vitest";
import { serviceCompatSettings } from "../../../src/harness/openai-compatible-provider/compat-settings.ts";
import { configuredModels } from "../../../src/harness/openai-compatible-provider/model-settings.ts";
import { comparableModelsDocument, modelSettingsView } from "../../../src/harness/openai-compatible-provider/settings-view.ts";

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
	const { defaults } = serviceCompatSettings(provider, { api: model.api, baseUrl }, { id, defaults: {}, configured: {} });
	const compat: OpenAICompletionsCompat = defaults;
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
	const provider = { api: "openai-completions", baseUrl: "https://api.deepseek.com/v1",
		compat: { supportsStore: true } };
	const defaults = serviceCompatSettings("local", provider, { id: "m",
		defaults: { compat: { thinkingFormat: "qwen", supportsStore: false } }, configured: { compat: { thinkingFormat: "openai" } },
	});
	expect(defaults.defaults).toMatchObject({ thinkingFormat: "qwen", supportsStore: false, maxTokensField: "max_tokens" });
	expect(defaults.own).toEqual({ thinkingFormat: "openai" });
	expect(serviceCompatSettings("local", provider).defaults).toMatchObject({ thinkingFormat: "deepseek", supportsStore: false });
});

it("修改模型地址或协议立即重新解析默认值", () => {
	const provider = { api: "openai-completions", baseUrl: "https://api.deepseek.com/v1" };
	expect(serviceCompatSettings("local", provider, { id: "m", defaults: {}, configured: { baseUrl: "http://localhost/v1" } }).defaults)
		.toMatchObject({ thinkingFormat: "openai", maxTokensField: "max_completion_tokens", supportsDeveloperRole: true });
	expect(serviceCompatSettings("local", provider, { id: "m", defaults: {}, configured: { api: "openai-responses" } }))
		.toMatchObject({ api: "openai-responses", defaults: { supportsDeveloperRole: true, supportsReasoningEffort: false },
			capabilities: { effortControl: "unused", on: { effort: "level" }, off: { effort: "none" } } });
});

it.each(["anthropic-messages", "unknown-api"])("模型使用 %s 时不推导 OpenAI 默认值", (api) => {
	const provider = { api: "openai-completions", baseUrl: "https://api.deepseek.com/v1" };
	const configured = { api, reasoning: true, compat: { supportsDeveloperRole: true }, thinkingLevelMap: { off: "none", high: "high" } };
	const view = modelSettingsView("local", provider, { id: "m", defaults: {}, configured });
	expect(view.compat.api).toBeUndefined();
	expect(view.compat.capabilities).toBeUndefined();
	expect(view.compat.defaults).toEqual({});
	expect(view.thinking.rows.every((row) => row.defaultValue === undefined && !row.mapsEffort)).toBe(true);
	expect(view.overrides).toEqual(configured);
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
	expect(view.compat.defaults.maxTokensField).toBe("max_tokens");
	expect(view.thinking.rows.find((row) => row.level === "high")).toMatchObject({ defaultValue: "custom", modified: false });
	expect(view.overrides).toEqual({ extra: { keep: true } });
	expect(comparableModelsDocument(document)).toMatchObject({ providers: { local: {
		custom: { keep: true }, modelOverrides: { m: { extra: { keep: true } } },
	} } });
	expect(JSON.stringify(document)).toBe(original);
});

it("服务级模型默认值不一致时不伪造布尔值，模型内显示具体值", () => {
	const provider = { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", models: [{ id: "openai/m" }, { id: "other/m" }] };
	expect(serviceCompatSettings("local", provider).defaults.supportsDeveloperRole).toBeUndefined();
	for (const id of ["openai/m", "other/m"]) {
		expect(serviceCompatSettings("local", provider, { id, defaults: {}, configured: {} }).defaults.supportsDeveloperRole).toBe(id === "openai/m");
	}
	expect(serviceCompatSettings("local", { ...provider, models: [{ id: "openai/m" }] }).defaults.supportsDeveloperRole).toBe(true);
});

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { fetchModelCandidates } from "../../../src/harness/model-services/fetch-candidates.ts";
import type { ProviderConfig } from "../../../src/harness/model-services/schema.ts";
import { useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("opi-native-candidates-");
afterEach(() => vi.restoreAllMocks());
async function setup(config: ProviderConfig) {
	const modelsPath = path.join(temp.path, "models.json");
	await writeFile(modelsPath, JSON.stringify({ providers: { local: { apiKey: "configured", ...config } } }));
	const runtime = await ModelRuntime.create({ modelsPath, credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
	return { runtime, modelsPath, query: () => fetchModelCandidates(runtime, "local", config, new AbortController().signal) };
}

it.each(["https://models.test", "https://models.test/v1", "https://models.test/v1/"])("Anthropic 自动匹配 %s 的地址、认证和分页", async (baseUrl) => {
	const { runtime, query } = await setup({ api: "anthropic-messages", baseUrl });
	const requests: { url: string; headers: Headers }[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		requests.push({ url: String(url), headers: new Headers(init?.headers) });
		return Response.json(requests.length === 1 ? { data: [{ id: "claude-first" }], has_more: true, last_id: "claude-first" }
			: { data: [{ id: "claude-next" }], has_more: false });
	});
	expect(await query()).toMatchObject({ candidates: [{ id: "claude-first" }, { id: "claude-next" }], connection: { status: "connected" } });
	expect(requests.map(({ url }) => url)).toEqual(["https://models.test/v1/models", "https://models.test/v1/models?after_id=claude-first"]);
	expect(requests[0]?.headers.get("x-api-key")).toBe("configured");
	expect(requests[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
	expect(requests[0]?.headers.has("Authorization")).toBe(false);
	expect(runtime.getModels("local")).toEqual([]);
});

it("Google 使用版本地址与专用认证，处理分页、资源名前缀和生成能力", async () => {
	const { query } = await setup({ api: "google-generative-ai", baseUrl: "https://models.test/gemini/v1beta/" });
	const requests: { url: string; headers: Headers }[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		requests.push({ url: String(url), headers: new Headers(init?.headers) });
		return Response.json(requests.length === 1 ? { models: [
			{ name: "models/gemini-first", inputTokenLimit: 100000, supportedGenerationMethods: ["generateContent"] },
			{ name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
		], nextPageToken: "page+2" } : { models: [{ name: "models/gemini-next", supportedGenerationMethods: ["generateContent"] }] });
	});
	expect(await query()).toMatchObject({ candidates: [{ id: "gemini-first", contextWindow: 100000 }, { id: "gemini-next" }], connection: { status: "connected" } });
	expect(requests.map(({ url }) => url)).toEqual(["https://models.test/gemini/v1beta/models", "https://models.test/gemini/v1beta/models?pageToken=page%2B2"]);
	expect(requests[0]?.headers.get("x-goog-api-key")).toBe("configured");
	expect(requests[0]?.headers.has("Authorization")).toBe(false);
});

it("只有模型级 API 和地址时按原生继承查询", async () => {
	const { query } = await setup({ models: [{ id: "m", api: "anthropic-messages", baseUrl: "https://models.test" }] });
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: [] }));
	expect(await query()).toMatchObject({ connection: { status: "connected" } });
	expect(String(fetch.mock.calls[0]?.[0])).toBe("https://models.test/v1/models");
});

it("混合连接不猜测协议，也不把 SDK 目录当作连接成功", async () => {
	const { query } = await setup({ models: [
		{ id: "claude", api: "anthropic-messages", baseUrl: "https://models.test" },
		{ id: "gemini", api: "google-generative-ai", baseUrl: "https://other.test/v1beta" },
	] });
	const fetch = vi.spyOn(globalThis, "fetch");
	expect(await query()).toMatchObject({ candidates: [{ id: "claude" }, { id: "gemini" }], connection: { status: "catalog", httpStatus: null } });
	expect(fetch).not.toHaveBeenCalled();
});

it("未内置列表协议时只读 SDK 目录，不刷新或加载待重载的地址、认证和模型", async () => {
	const config = { api: "azure-openai-responses", baseUrl: "https://models.test", models: [{ id: "m" }] };
	const { runtime, query, modelsPath } = await setup(config);
	await writeFile(modelsPath, JSON.stringify({ providers: { local: {
		...config, baseUrl: "https://new.test", apiKey: "new-key", models: [{ id: "new-model" }],
	} } }));
	const fetch = vi.spyOn(globalThis, "fetch");
	const result = await query();
	expect(runtime.getModel("local", "m")?.baseUrl).toBe(config.baseUrl);
	expect(runtime.getModel("local", "new-model")).toBeUndefined();
	expect((await runtime.getAuth("local"))?.auth.apiKey).toBe("configured");
	expect(result.connection.status).toBe("catalog");
	expect(result.candidates.map(({ id }) => id)).toEqual(["m"]);
	expect(fetch).not.toHaveBeenCalled();
});

it("没有列表协议且目录为空时，不发送猜测请求", async () => {
	const { query } = await setup({ api: "azure-openai-responses", baseUrl: "https://models.test" });
	const fetch = vi.spyOn(globalThis, "fetch");
	expect(await query()).toMatchObject({ candidates: [], connection: { status: "unsupported" } });
	expect(fetch).not.toHaveBeenCalled();
});

it("已取消的候选查询不返回 SDK 目录", async () => {
	const config = { api: "azure-openai-responses", baseUrl: "https://models.test", models: [{ id: "m" }] };
	const { runtime } = await setup(config);
	const controller = new AbortController();
	const reason = new Error("cancelled");
	controller.abort(reason);
	const fetch = vi.spyOn(globalThis, "fetch");
	await expect(fetchModelCandidates(runtime, "local", config, controller.signal)).rejects.toBe(reason);
	expect(fetch).not.toHaveBeenCalled();
});

it.each([
	["anthropic-messages", { data: [{ id: "m" }], has_more: true }],
	["google-generative-ai", { models: [{ name: "models/" }] }],
])("拒绝 %s 的畸形列表，不暴露响应正文", async (api, payload) => {
	const { query } = await setup({ api, baseUrl: "https://models.test/v1" });
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(payload));
	expect(await query()).toMatchObject({ candidates: [], connection: { status: "invalid-response" } });
});

it("重复分页游标立即终止，不返回部分候选", async () => {
	const { query } = await setup({ api: "google-generative-ai", baseUrl: "https://models.test/v1beta" });
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ models: [], nextPageToken: "same" }));
	expect(await query()).toMatchObject({ candidates: [], connection: { status: "invalid-response" } });
	expect(fetch).toHaveBeenCalledTimes(2);
});

it("Anthropic 候选查询识别 OAuth token，保留显式版本请求头", async () => {
	const { query } = await setup({ api: "anthropic-messages", baseUrl: "https://models.test", apiKey: "sk-ant-oat-token",
		headers: { "anthropic-version": "custom" } });
	const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [] }));
	expect(await query()).toMatchObject({ connection: { status: "connected" } });
	const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
	expect(headers.get("Authorization")).toBe("Bearer sk-ant-oat-token");
	expect(headers.has("x-api-key")).toBe(false);
	expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
	expect(headers.get("anthropic-version")).toBe("custom");
});

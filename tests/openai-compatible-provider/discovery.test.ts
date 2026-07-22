import path from "node:path";
import type { ModelsStoreEntry } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { registerOpenAICompatibleProviders } from "../../src/openai-compatible-provider/index.js";
import { createExtensionHarness, fetchNormalizedProvider, jsonResponse, loadConfigFromText } from "./fixtures.js";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.js";

const temp = useOpenAICompatibleProviderTestSetup();

describe("openai-compatible-provider model discovery", () => {
	it("原生 Provider 从 Pi ModelsStore 恢复动态目录且不覆盖手写模型", async () => {
		const config = await loadConfigFromText(temp.path, `{
			"providers": {
				"local": {
					"baseUrl": "http://127.0.0.1:8000/v1",
					"apiKey": "EMPTY",
					"models": [{ "id": "manual", "name": "Manual" }]
				}
			}
		}`);
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{ "data": [{ "id": "manual", "name": "Remote" }, { "id": "dynamic" }] }'));
		const stores = new Map<string, ModelsStoreEntry>();
		const store = {
			read: async () => stores.get("local"),
			write: async (entry: ModelsStoreEntry) => { stores.set("local", entry); },
			delete: async () => { stores.delete("local"); },
		};
		const firstHarness = createExtensionHarness();
		const [first] = registerOpenAICompatibleProviders(firstHarness.pi, config, path.join(temp.path, "models.jsonc"));
		await first?.refreshModels?.({ credential: { type: "api_key", key: "unused" }, store, allowNetwork: true });
		expect(first?.getModels().map((model) => [model.id, model.name])).toEqual([
			["manual", "Manual"],
			["dynamic", "dynamic"],
		]);

		const stored = stores.get("local");
		if (!stored?.models[0]) throw new Error("dynamic model was not stored");
		stores.set("local", {
			...stored,
			models: [
				{ ...stored.models[0], id: "manual", name: "Stale Remote Manual", baseUrl: "https://stale.test/v1" },
				...stored.models,
			],
		});
		const secondHarness = createExtensionHarness();
		const [second] = registerOpenAICompatibleProviders(secondHarness.pi, config, path.join(temp.path, "models.jsonc"));
		await second?.refreshModels?.({ credential: { type: "api_key", key: "unused" }, store, allowNetwork: false });
		expect(second?.getModels().map((model) => [model.id, model.name, model.baseUrl])).toEqual([
			["manual", "Manual", "http://127.0.0.1:8000/v1"],
			["dynamic", "dynamic", "http://127.0.0.1:8000/v1"],
		]);

		stores.delete("local");
		fetch.mockRejectedValueOnce(new Error("offline"));
		await expect(second?.refreshModels?.({
			credential: { type: "api_key", key: "unused" },
			store,
			allowNetwork: true,
		})).rejects.toThrow("offline");
		expect(second?.getModels().map((model) => model.id)).toEqual(["manual", "dynamic"]);
		stores.set("local", stored);

		fetch.mockResolvedValueOnce(new Response('{ "data": [{ "id": "replacement" }] }'));
		await expect(second?.refreshModels?.({
			credential: { type: "api_key", key: "unused" },
			store: { ...store, write: async () => { throw new Error("store failed"); } },
			allowNetwork: true,
		})).rejects.toThrow("store failed");
		expect(second?.getModels().map((model) => model.id)).toEqual(["manual", "dynamic"]);

		const changedConfig = await loadConfigFromText(temp.path, `{
			"providers": {
				"local": {
					"baseUrl": "http://127.0.0.1:9000/v1",
					"apiKey": "EMPTY",
					"models": ["manual"]
				}
			}
		}`);
		const thirdHarness = createExtensionHarness();
		const [third] = registerOpenAICompatibleProviders(thirdHarness.pi, changedConfig, path.join(temp.path, "models.jsonc"));
		await third?.refreshModels?.({ credential: { type: "api_key", key: "unused" }, store, allowNetwork: false });
		expect(third?.getModels().map((model) => model.id)).toEqual(["manual"]);
		expect(globalThis.fetch).toHaveBeenCalledTimes(3);
	});

	it("在线刷新会等待进行中的离线恢复并继续请求网络", async () => {
		const config = await loadConfigFromText(temp.path, `{
			"providers": { "local": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "EMPTY" } }
		}`);
		const harness = createExtensionHarness();
		const [provider] = registerOpenAICompatibleProviders(harness.pi, config, path.join(temp.path, "models.jsonc"));
		if (!provider?.refreshModels) throw new Error("refreshModels missing");
		let releaseRead: (() => void) | undefined;
		let readCount = 0;
		const firstRead = new Promise<void>((resolve) => { releaseRead = resolve; });
		const store = {
			read: async () => {
				readCount++;
				if (readCount === 1) await firstRead;
				return undefined;
			},
			write: async () => undefined,
			delete: async () => undefined,
		};
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{ "data": [{ "id": "dynamic" }] }'));

		const offline = provider.refreshModels({ credential: { type: "api_key", key: "unused" }, store, allowNetwork: false });
		const online = provider.refreshModels({ credential: { type: "api_key", key: "unused" }, store, allowNetwork: true });
		releaseRead?.();
		await Promise.all([offline, online]);

		expect(readCount).toBe(2);
		expect(fetch).toHaveBeenCalledOnce();
		expect(provider.getModels().map((model) => model.id)).toEqual(["dynamic"]);
	});

	it("models: auto 会调用 provider models endpoint 并注册发现到的模型", async () => {
		const config = await loadConfigFromText(temp.path, `{
			"providers": {
				"gateway": {
					"name": "Gateway",
					"baseUrl": "https://gateway.example.com/v1",
					"apiKey": "$GATEWAY_API_KEY",
					"models": "auto"
				}
			}
		}`);
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		const provider = await fetchNormalizedProvider(temp.path, config, "gateway", {
			env: { GATEWAY_API_KEY: "sk-test" },
			fetch: async (url, init) => {
				calls.push({ url, headers: init.headers });
				return jsonResponse({
					data: [
						{
							id: "vision-model",
							name: "Vision Model",
							context_length: 200000,
							top_provider: { max_completion_tokens: 8192 },
							architecture: { input_modalities: ["text", "image"] },
						},
					],
				});
			},
		});

		expect(calls).toEqual([
			{
				url: "https://gateway.example.com/v1/models",
				headers: { Accept: "application/json", Authorization: "Bearer sk-test" },
			},
		]);
		expect(provider?.models?.[0]).toMatchObject({
			id: "vision-model",
			name: "Vision Model",
			contextWindow: 200000,
			maxTokens: 8192,
			input: ["text", "image"],
		});
	});

	it("手写 models 会合并 models endpoint，冲突时保留手写配置", async () => {
		const config = await loadConfigFromText(temp.path, `{
			"providers": {
				"gateway": {
					"baseUrl": "https://gateway.example.com/v1",
					"apiKey": "EMPTY",
					"models": [
						{
							"id": "manual-model",
							"name": "Manual Model",
							"contextWindow": 1000,
							"maxTokens": 100
						},
						"manual-string"
					]
				}
			}
		}`);
		const calls: string[] = [];
		const provider = await fetchNormalizedProvider(temp.path, config, "gateway", {
			fetch: async (url) => {
				calls.push(url);
				return jsonResponse({
					data: [
						{ id: "manual-model", name: "Endpoint Manual", context_length: 200000, max_completion_tokens: 8192 },
						{ id: "manual-string", name: "Endpoint String", context_length: 200000 },
						{ id: "endpoint-only", name: "Endpoint Only", context_length: 300000 },
					],
				});
			},
		});
		const models = provider?.models ?? [];

		expect(calls).toEqual(["https://gateway.example.com/v1/models"]);
		expect(models.map((model) => model.id)).toEqual(["manual-model", "manual-string", "endpoint-only"]);
		expect(models[0]).toMatchObject({
			id: "manual-model",
			name: "Manual Model",
			contextWindow: 1000,
			maxTokens: 100,
		});
		expect(models[1]).toMatchObject({
			id: "manual-string",
			name: "manual-string",
			contextWindow: 128000,
		});
		expect(models[2]).toMatchObject({
			id: "endpoint-only",
			name: "Endpoint Only",
			contextWindow: 300000,
		});
	});

	it("省略 models 时默认从 /models 自动发现，EMPTY 不发送 Authorization", async () => {
		const config = await loadConfigFromText(temp.path, `{
			"providers": {
				"local": {
					"baseUrl": "http://127.0.0.1:8000/v1",
					"apiKey": "EMPTY"
				}
			}
		}`);
		let headers: Record<string, string> | undefined;
		const provider = await fetchNormalizedProvider(temp.path, config, "local", {
			fetch: async (_url, init) => {
				headers = init.headers;
				return jsonResponse({ data: [{ id: "local-model" }] });
			},
		});

		expect(headers).toEqual({ Accept: "application/json" });
		expect(provider?.models?.[0]?.id).toBe("local-model");
	});

	it("自动发现模型失败时输出 provider 和 HTTP 状态且不泄露 Authorization", async () => {
		const config = await loadConfigFromText(temp.path, `{
			"providers": {
				"gateway": {
					"baseUrl": "https://gateway.example.com/v1",
					"apiKey": "sk-secret",
					"models": "auto"
				}
			}
		}`);

		await expect(
			fetchNormalizedProvider(temp.path, config, "gateway", {
				fetch: async () => jsonResponse({ error: "unauthorized" }, { ok: false, status: 401, statusText: "Unauthorized" }),
			}),
		).rejects.toThrow('provider "gateway" models endpoint returned HTTP 401 Unauthorized');
		await expect(
			fetchNormalizedProvider(temp.path, config, "gateway", {
				fetch: async () => jsonResponse({ error: "unauthorized" }, { ok: false, status: 401, statusText: "Unauthorized" }),
			}),
		).rejects.not.toThrow("sk-secret");
	});

	it("模型发现超时覆盖响应 body 读取", async () => {
		vi.useFakeTimers();
		const config = await loadConfigFromText(temp.path, `{
			"providers": {
				"gateway": { "baseUrl": "https://gateway.example.com/v1", "apiKey": "EMPTY", "models": "auto" }
			}
		}`);
		const promise = fetchNormalizedProvider(temp.path, config, "gateway", {
			timeoutMs: 10,
			fetch: async (_url, init) => ({
				ok: true,
				status: 200,
				text: () => new Promise<string>((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
				}),
			}),
		});
		const rejected = expect(promise).rejects.toThrow("response cannot be read");

		await vi.advanceTimersByTimeAsync(10);
		await rejected;
	});
});

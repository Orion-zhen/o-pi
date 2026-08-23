import path from "node:path";
import type { ApiKeyCredential, AuthResult, ModelsStoreEntry, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { registerOpenAICompatibleProviders } from "../../src/openai-compatible-provider/register.js";
import { createExtensionHarness, loadConfigFromText, providerConfigText } from "./fixtures.js";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.js";

const temp = useOpenAICompatibleProviderTestSetup();

describe("openai-compatible-provider model discovery", () => {
	it("createProvider 原生生命周期恢复缓存、联网覆盖目录并保留旧快照", async () => {
		const config = await loadConfigFromText(temp.path, providerConfigText({
			baseUrl: "http://127.0.0.1:8000/v1",
			apiKey: "sk-test",
			models: [{ id: "manual", name: "Manual" }],
		}, "local"));
		const fetch = vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(jsonResponse({
				data: [
					{
						id: "manual",
						context_length: 200000,
						architecture: { input_modalities: ["text", "image"] },
					},
					{ id: "dynamic" },
				],
			}))
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(jsonResponse({ data: [{ id: "replacement" }] }));
		const stores = new Map<string, ModelsStoreEntry>();
		const publish = createMapPublisher(stores, "local");
		const firstHarness = createExtensionHarness();
		const [first] = registerOpenAICompatibleProviders(firstHarness.pi, config, path.join(temp.path, "models.jsonc"));
		if (!first) throw new Error("first provider was not registered");
		await refreshProvider(first, { publish, allowNetwork: true });
		expect(first.getModels()).toMatchObject([
			{
				id: "manual",
				name: "Manual",
				contextWindow: 200000,
				input: ["text", "image"],
			},
			{ id: "dynamic", name: "dynamic" },
		]);
		expect(firstHarness.providers).toEqual([first]);

		const stored = stores.get("local");
		if (!stored) throw new Error("merged models were not stored");
		expect(stored.models.every((model) => model.headers === undefined)).toBe(true);
		expect(stored.models.every((model) => !Object.hasOwn(model.headers ?? {}, "x-o-pi-model-source"))).toBe(true);
		expect(stored.models.map((model) => model.id)).toEqual(["manual", "dynamic"]);

		const secondHarness = createExtensionHarness();
		const [second] = registerOpenAICompatibleProviders(secondHarness.pi, config, path.join(temp.path, "models.jsonc"));
		if (!second) throw new Error("second provider was not registered");
		await refreshProvider(second, { stored, publish, allowNetwork: false });
		expect(second.getModels()).toMatchObject([
			{
				id: "manual",
				name: "Manual",
				baseUrl: "http://127.0.0.1:8000/v1",
				contextWindow: 200000,
				input: ["text", "image"],
			},
			{ id: "dynamic", name: "dynamic", baseUrl: "http://127.0.0.1:8000/v1" },
		]);
		expect(secondHarness.providers).toEqual([second]);
		expect(fetch).toHaveBeenCalledOnce();

		stores.delete("local");
		await expect(refreshProvider(second, { publish, allowNetwork: true })).rejects.toThrow("offline");
		expect(second.getModels().map((model) => model.id)).toEqual(["manual", "dynamic"]);
		stores.set("local", stored);

		await expect(refreshProvider(second, {
			allowNetwork: true,
			publish: async () => { throw new Error("store failed"); },
		})).rejects.toThrow("store failed");
		expect(second.getModels().map((model) => model.id)).toEqual(["manual", "dynamic"]);

		const changedConfig = await loadConfigFromText(temp.path, providerConfigText({
			baseUrl: "http://127.0.0.1:8000/v1",
			apiKey: "sk-test",
			models: [{ id: "manual", name: "Changed Manual" }],
		}, "local"));
		const thirdHarness = createExtensionHarness();
		const [third] = registerOpenAICompatibleProviders(thirdHarness.pi, changedConfig, path.join(temp.path, "models.jsonc"));
		if (!third) throw new Error("third provider was not registered");
		await refreshProvider(third, { stored, publish, allowNetwork: false });
		expect(third.getModels().map((model) => [model.id, model.name, model.contextWindow])).toEqual([
			["manual", "Manual", 200000],
			["dynamic", "dynamic", 128000],
		]);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("models: auto 使用当前 data 响应发现模型及其上下文窗口和图片输入能力", async () => {
		const config = await loadConfigFromText(temp.path, providerConfigText({
			name: "Gateway",
			baseUrl: "https://gateway.example.com/v1",
			apiKey: "sk-test",
			models: "auto",
		}));
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers)) });
			return jsonResponse(CURRENT_MODELS_RESPONSE);
		});
		const [provider] = registerOpenAICompatibleProviders(
			createExtensionHarness().pi,
			config,
			path.join(temp.path, "models.jsonc"),
		);
		if (!provider) throw new Error("provider was not registered");
		await refreshProvider(provider, { allowNetwork: true });

		expect(calls).toEqual([
			{
				url: "https://gateway.example.com/v1/models",
				headers: { accept: "application/json", authorization: "Bearer sk-test" },
			},
		]);
		expect(provider.getModels()).toMatchObject([
			{
				id: "vision-model",
				name: "vision-model",
				contextWindow: 200000,
				maxTokens: 16384,
				input: ["text", "image"],
			},
			{
				id: "text-model",
				name: "text-model",
				contextWindow: 128000,
				input: ["text"],
			},
		]);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("手写 models 覆盖显式字段并由 models endpoint 补齐缺失元数据", async () => {
		const config = await loadConfigFromText(temp.path, providerConfigText({
			baseUrl: "https://gateway.example.com/v1",
			apiKey: "sk-test",
			models: [
				{ id: "manual-model", name: "Manual Model", contextWindow: 1000, maxTokens: 100 },
				"manual-string",
			],
		}));
		const calls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			calls.push(String(input));
			return jsonResponse({
				data: [
					{
						id: "manual-model",
						context_length: 200000,
						architecture: { input_modalities: ["text", "image"] },
					},
					{ id: "manual-string", context_length: 200000 },
					{ id: "endpoint-only", context_length: 300000 },
				],
			});
		});
		const [provider] = registerOpenAICompatibleProviders(
			createExtensionHarness().pi,
			config,
			path.join(temp.path, "models.jsonc"),
		);
		if (!provider) throw new Error("provider was not registered");
		await refreshProvider(provider, { allowNetwork: true });
		const models = provider.getModels();

		expect(calls).toEqual(["https://gateway.example.com/v1/models"]);
		expect(models.map((model) => model.id)).toEqual(["manual-model", "manual-string", "endpoint-only"]);
		expect(models[0]).toMatchObject({
			id: "manual-model",
			name: "Manual Model",
			contextWindow: 1000,
			maxTokens: 100,
			input: ["text", "image"],
		});
		expect(models[1]).toMatchObject({
			id: "manual-string",
			name: "manual-string",
			contextWindow: 200000,
		});
		expect(models[2]).toMatchObject({
			id: "endpoint-only",
			name: "endpoint-only",
			contextWindow: 300000,
		});
	});

	it.each([
		[[], "must be an object containing a data array"],
		[{ models: [{ id: "m" }] }, "must be an object containing a data array"],
		[{ data: ["m"] }, "data[0] must be an object"],
		[{ data: [{ model: "m" }] }, "data[0].id is required"],
		[{ data: [{ id: "   " }] }, "data[0].id is required"],
		[{ data: [] }, "returned no models"],
	] as const)("拒绝不支持的模型目录响应 %#", async (payload, expected) => {
		const config = await loadConfigFromText(temp.path, providerConfigText({ models: "auto" }));
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(payload));
		const [provider] = registerOpenAICompatibleProviders(
			createExtensionHarness().pi,
			config,
			path.join(temp.path, "models.jsonc"),
		);
		if (!provider) throw new Error("provider was not registered");

		await expect(refreshProvider(provider, { allowNetwork: true })).rejects.toThrow(expected);
	});

	it("重复的 endpoint 模型 ID 进入统一归一化校验", async () => {
		const config = await loadConfigFromText(temp.path, providerConfigText({ models: [{ id: "duplicate", name: "Manual" }] }));
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
			data: [{ id: "duplicate", context_length: 1000 }, { id: "duplicate", context_length: 2000 }],
		}));
		const [provider] = registerOpenAICompatibleProviders(
			createExtensionHarness().pi,
			config,
			path.join(temp.path, "models.jsonc"),
		);
		if (!provider) throw new Error("provider was not registered");

		await expect(refreshProvider(provider, { allowNetwork: true })).rejects.toThrow(
			'provider "gateway" contains duplicate model "duplicate"',
		);
	});

	it("忽略模型目录中未声明的元数据别名", async () => {
		const config = await loadConfigFromText(temp.path, providerConfigText({ models: "auto" }));
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
			data: [{
				id: "strict-model",
				name: "Remote Name",
				display_name: "Display Name",
				context_window: 999,
				max_completion_tokens: 999,
				input_modalities: ["image"],
				architecture: { input_modalities: ["text", "vision"] },
			}],
		}));
		const [provider] = registerOpenAICompatibleProviders(
			createExtensionHarness().pi,
			config,
			path.join(temp.path, "models.jsonc"),
		);
		if (!provider) throw new Error("provider was not registered");
		await refreshProvider(provider, { allowNetwork: true });

		expect(provider.getModels()[0]).toMatchObject({
			id: "strict-model",
			name: "strict-model",
			contextWindow: 128000,
			maxTokens: 16384,
			input: ["text"],
		});
	});

	it("使用 Pi 已解析的 keyless credential 刷新时不发送 Authorization", async () => {
		const config = await loadConfigFromText(temp.path, providerConfigText({
			baseUrl: "http://127.0.0.1:8000/v1",
			apiKey: "EMPTY",
			models: "auto",
		}, "local"));
		let headers: Record<string, string> | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			headers = Object.fromEntries(new Headers(init?.headers));
			return jsonResponse({ data: [{ id: "local-model" }] });
		});
		const [provider] = registerOpenAICompatibleProviders(
			createExtensionHarness().pi,
			config,
			path.join(temp.path, "models.jsonc"),
		);
		if (!provider) throw new Error("provider was not registered");
		const auth = provider.auth.apiKey;
		if (!auth?.resolve) throw new Error("provider API-key auth is missing");
		const result = await auth.resolve({
			ctx: { env: async () => undefined, fileExists: async () => false },
			signal: new AbortController().signal,
		});
		if (!result) throw new Error("keyless auth unexpectedly missing");
		await refreshProvider(provider, { credential: credentialFromAuth(result), allowNetwork: true });

		expect(headers).toEqual({ accept: "application/json" });
		expect(provider.getModels()[0]?.id).toBe("local-model");
	});

	it("远端独有模型使用 fallback runtime，远端补全手写模型保留手写 runtime", async () => {
		const config = await loadConfigFromText(temp.path, providerConfigText({
			api: "openai-responses",
			apiKey: "sk-test",
			thinkingPreset: "qwen",
			models: [{ id: "manual", defaultThinkingLevel: "high" }],
		}));
		const payloads = new Map<string, unknown>();
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(jsonResponse({ data: [{ id: "manual" }, { id: "dynamic" }] }))
			.mockImplementation(async () => new Response('{"error":"stop"}', { status: 400 }));
		const [provider] = registerOpenAICompatibleProviders(
			createExtensionHarness().pi,
			config,
			path.join(temp.path, "models.jsonc"),
		);
		if (!provider) throw new Error("provider was not registered");
		await refreshProvider(provider, { allowNetwork: true });

		for (const id of ["manual", "dynamic"]) {
			const model = provider.getModels().find((entry) => entry.id === id);
			if (!model) throw new Error(`model ${id} was not discovered`);
			for await (const _event of provider.stream(model, {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			}, {
				apiKey: "sk-test",
				reasoningEffort: "high",
				onPayload: (payload) => {
					payloads.set(id, payload);
					return payload;
				},
			})) {
			}
		}

		expect(payloads.get("manual")).toHaveProperty("enable_thinking", true);
		expect(payloads.get("dynamic")).not.toHaveProperty("enable_thinking");
	});

	it("模型目录刷新收到非 API key credential 时明确失败", async () => {
		const config = await loadConfigFromText(temp.path, providerConfigText({ models: "auto" }));
		const [provider] = registerOpenAICompatibleProviders(
			createExtensionHarness().pi,
			config,
			path.join(temp.path, "models.jsonc"),
		);
		if (!provider) throw new Error("provider was not registered");

		await expect(refreshProvider(provider, {
			allowNetwork: true,
			credential: { type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 60_000 },
		})).rejects.toThrow('Provider "gateway" model refresh requires an API key credential');
	});

	it("自动发现模型失败时输出 provider 和 HTTP 状态且不泄露 Authorization", async () => {
		const config = await loadConfigFromText(temp.path, providerConfigText({
			baseUrl: "https://gateway.example.com/v1",
			apiKey: "sk-secret",
			models: "auto",
		}));
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ error: "unauthorized" }, { status: 401, statusText: "Unauthorized" }),
		);
		const [provider] = registerOpenAICompatibleProviders(
			createExtensionHarness().pi,
			config,
			path.join(temp.path, "models.jsonc"),
		);
		if (!provider) throw new Error("provider was not registered");

		await expect(refreshProvider(provider, { allowNetwork: true })).rejects.toThrow(
			'provider "gateway" models endpoint returned HTTP 401 Unauthorized',
		);
		await expect(refreshProvider(provider, { allowNetwork: true })).rejects.not.toThrow("sk-secret");
	});

	it("模型发现无效 JSON、响应读取失败、超时和取消都有明确错误且清理请求", async () => {
		const config = await loadConfigFromText(temp.path, providerConfigText({
			baseUrl: "https://gateway.example.com/v1",
			apiKey: "sk-test",
			models: "auto",
		}));
		const [provider] = registerOpenAICompatibleProviders(
			createExtensionHarness().pi,
			config,
			path.join(temp.path, "models.jsonc"),
		);
		if (!provider) throw new Error("provider was not registered");

		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json"));
		await expect(refreshProvider(provider, { allowNetwork: true })).rejects.toThrow("did not return valid JSON");

		const unreadable = new Response();
		Object.defineProperty(unreadable, "text", { value: () => Promise.reject(new Error("body failed")) });
		fetch.mockResolvedValue(unreadable);
		await expect(refreshProvider(provider, { allowNetwork: true })).rejects.toThrow("response cannot be read: body failed");

		vi.useFakeTimers();
		vi.mocked(globalThis.fetch).mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) throw new Error("request signal missing");
			const rejectOnAbort = () => reject(new DOMException("aborted", "AbortError"));
			if (signal.aborted) rejectOnAbort();
			else signal.addEventListener("abort", rejectOnAbort, { once: true });
		}));
		const timeoutPromise = refreshProvider(provider, { allowNetwork: true });
		const timeoutError = expect(timeoutPromise).rejects.toThrow("timed out after 30000ms");
		await vi.advanceTimersByTimeAsync(30000);
		await timeoutError;

		const controller = new AbortController();
		const cancelPromise = refreshProvider(provider, { allowNetwork: true, signal: controller.signal });
		controller.abort();
		await expect(cancelPromise).rejects.toThrow("cancelled");
	});
});

const CURRENT_MODELS_RESPONSE = {
	data: [
		{
			id: "vision-model",
			context_length: 200000,
			architecture: { input_modalities: ["text", "image"] },
		},
		{
			id: "text-model",
			context_length: 128000,
			architecture: { input_modalities: ["text"] },
		},
	],
};

interface RefreshContextOptions {
	stored?: Readonly<ModelsStoreEntry>;
	publish?: RefreshModelsContext["publish"];
	allowNetwork: boolean;
	credential?: RefreshModelsContext["credential"];
	signal?: AbortSignal;
}

async function refreshProvider(provider: Provider, options: RefreshContextOptions): Promise<void> {
	if (!provider.refreshModels) throw new Error(`Provider ${provider.id} is not dynamic`);
	await provider.refreshModels(refreshContext(options));
}

function refreshContext(options: RefreshContextOptions): RefreshModelsContext {
	return {
		credential: options.credential ?? { type: "api_key", key: "sk-test" },
		...(options.stored !== undefined ? { stored: options.stored } : {}),
		publish: options.publish ?? (async (publication) => {
			publication.update?.();
			return true;
		}),
		allowNetwork: options.allowNetwork,
		signal: options.signal ?? new AbortController().signal,
	};
}

function createMapPublisher(
	stores: Map<string, ModelsStoreEntry>,
	providerId: string,
): RefreshModelsContext["publish"] {
	return async (publication) => {
		if (publication.persist === null) stores.delete(providerId);
		else if (publication.persist !== undefined) stores.set(providerId, publication.persist);
		publication.update?.();
		return true;
	};
}

function credentialFromAuth(result: AuthResult): ApiKeyCredential {
	return {
		type: "api_key",
		...(result.auth.apiKey !== undefined ? { key: result.auth.apiKey } : {}),
		...(result.env !== undefined ? { env: result.env } : {}),
	};
}

function jsonResponse(value: unknown, init: { status?: number; statusText?: string } = {}): Response {
	return new Response(JSON.stringify(value), {
		status: init.status ?? 200,
		...(init.statusText !== undefined ? { statusText: init.statusText } : {}),
		headers: { "content-type": "application/json" },
	});
}

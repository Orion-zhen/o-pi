import { writeFile } from "node:fs/promises";
import path from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { capturePayload, loadProvider } from "./fixtures.ts";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.ts";

const temp = useOpenAICompatibleProviderTestSetup();

describe("openai-compatible-provider model discovery", () => {
	it("ModelRuntime 发现模型、应用配置、离线恢复缓存，刷新失败时保留目录", async () => {
		vi.stubEnv("KEY", "sk-test");
		vi.stubEnv("TOKEN", "header-token");
		const modelsStore = new InMemoryModelsStore();
		const settings = {
			discoverModels: true, modelsEndpoint: "catalog", models: undefined,
			apiKey: "$KEY", headers: { "X-Token": "$TOKEN" },
			modelOverrides: { vision: { name: "Vision", maxTokens: 8192 } },
		};
		const fetch = vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(Response.json({ data: [
				{ id: "vision", context_length: 200000, architecture: { input_modalities: ["text", "image"] } },
				{ id: "text" },
			] }))
			.mockRejectedValueOnce(new Error("offline"));
		const first = await loadProvider(temp.path, settings, "gateway", modelsStore);
		expect(fetch).not.toHaveBeenCalled();
		expect((await first.runtime.refresh({ allowNetwork: true, providers: ["gateway"] })).errors.size).toBe(0);
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe("https://gateway.example.test/v1/catalog");
		expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
			accept: "application/json", authorization: "Bearer sk-test", "x-token": "header-token",
		});
		expect(first.runtime.getModels("gateway")).toMatchObject([
			{ id: "vision", name: "Vision", contextWindow: 200000, maxTokens: 8192, input: ["text", "image"] },
			{ id: "text", contextWindow: 128000, input: ["text"] },
		]);
		expect((await modelsStore.read("gateway"))?.models.map((model) => model.id)).toEqual(["vision", "text"]);

		const restored = await loadProvider(temp.path, {
			...settings, modelOverrides: { vision: { name: "Renamed", maxTokens: 4096 } },
		}, "gateway", modelsStore);
		expect((await restored.runtime.refresh({ allowNetwork: false, providers: ["gateway"] })).errors.size).toBe(0);
		expect(fetch).toHaveBeenCalledOnce();
		expect(restored.runtime.getModel("gateway", "vision")).toMatchObject({
			name: "Renamed", contextWindow: 200000, maxTokens: 4096, input: ["text", "image"],
		});
		const previous = restored.runtime.getModels("gateway");
		const result = await restored.runtime.refresh({ allowNetwork: true, providers: ["gateway"] });
		expect(result.errors.get("gateway")?.message).toContain("offline");
		expect(restored.runtime.getModels("gateway")).toEqual(previous);
		expect(restored.harness.providers).toHaveLength(1);
	});

	it("model-suffix 折叠发现的变体，缓存恢复后仍按思考等级发送请求", async () => {
		const modelsStore = new InMemoryModelsStore();
		const settings = { discoverModels: true, models: undefined, thinkingPreset: "model-suffix" };
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ data: [
			{ id: "m", context_length: 200000 }, { id: "m:off" }, { id: "m:high" }, { id: "m:max" },
		] }));
		const first = await loadProvider(temp.path, settings, "gateway", modelsStore);
		expect((await first.runtime.refresh({ allowNetwork: true, providers: ["gateway"] })).errors.size).toBe(0);
		expect(fetch.mock.calls[0]?.[0]).toBe("https://gateway.example.test/v1/models");
		expect(first.runtime.getModels("gateway")).toMatchObject([{
			id: "m", reasoning: true, contextWindow: 200000, thinkingLevelMap: { off: "off", high: "high", max: "max" },
		}]);
		expect((await modelsStore.read("gateway"))?.models.map((model) => model.id)).toEqual(["m"]);

		const restored = await loadProvider(temp.path, {
			...settings, modelOverrides: { m: { name: "Renamed" } },
		}, "gateway", modelsStore);
		expect((await restored.runtime.refresh({ allowNetwork: false, providers: ["gateway"] })).errors.size).toBe(0);
		expect(restored.runtime.getModel("gateway", "m")?.name).toBe("Renamed");
		expect(fetch).toHaveBeenCalledOnce();
		const request = await capturePayload(restored, { reasoning: "max" });
		expect(request).toHaveProperty("model", "m:max");
		expect(request).not.toHaveProperty("reasoning_effort");
		expect(await capturePayload(restored)).toHaveProperty("model", "m:off");
	});

	it("仅启用发现时保留冒号模型 ID 和原生请求", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ data: [{ id: "m" }, { id: "m:high" }] }));
		const fixture = await loadProvider(temp.path, { discoverModels: true, models: undefined });
		expect((await fixture.runtime.refresh({ allowNetwork: true, providers: ["gateway"] })).errors.size).toBe(0);
		expect(fixture.runtime.getModels("gateway").map((model) => model.id)).toEqual(["m", "m:high"]);
		expect(await capturePayload(fixture, {}, { modelId: "m:high" })).toHaveProperty("model", "m:high");
	});

	it("Responses 发现模型后，只有声明思考能力的模型应用预设", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ data: [{ id: "manual" }, { id: "dynamic" }] }));
		const fixture = await loadProvider(temp.path, {
			discoverModels: true, api: "openai-responses", thinkingPreset: "qwen",
			models: [{ id: "manual", reasoning: true }],
		});
		expect((await fixture.runtime.refresh({ allowNetwork: true, providers: ["gateway"] })).errors.size).toBe(0);
		expect(await capturePayload(fixture, { reasoning: "high" }, { modelId: "manual" })).toHaveProperty("enable_thinking", true);
		expect(await capturePayload(fixture, {}, { modelId: "dynamic" })).not.toHaveProperty("enable_thinking");
	});

	it("目录请求每次解析最新的命令请求头", async () => {
		const token = path.join(temp.path, "token");
		const resolver = path.join(temp.path, "resolve-header.cjs");
		await writeFile(resolver, `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(token)}, "utf8"));`);
		await writeFile(token, "first");
		const fixture = await loadProvider(temp.path, {
			discoverModels: true, headers: { "X-Token": `!"${process.execPath}" "${resolver}"` },
		});
		const headers: (string | null)[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			headers.push(new Headers(init?.headers).get("X-Token"));
			return Response.json({ data: [{ id: "m" }] });
		});
		expect((await fixture.runtime.refresh({ allowNetwork: true, providers: ["gateway"] })).errors.size).toBe(0);
		await writeFile(token, "second");
		expect((await fixture.runtime.refresh({ allowNetwork: true, providers: ["gateway"] })).errors.size).toBe(0);
		expect(headers).toEqual(["first", "second"]);
	});

	it.each([
		[401, '{"error":"unauthorized"}', "HTTP 401"],
		[200, "not json", "valid JSON"],
		[200, '{"models":[]}', "data array"],
		[200, '{"data":[]}', "no models"],
		[200, '{"data":[{}]}', ".id is required"],
		[200, '{"data":[{"id":"m"},{"id":"m"}]}', "duplicate model"],
	] as const)("目录响应异常 %s/%s 时报告错误并保留已有模型", async (status, body, message) => {
		const fixture = await loadProvider(temp.path, { discoverModels: true, apiKey: "sk-secret" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status }));
		const result = await fixture.runtime.refresh({ allowNetwork: true, providers: ["gateway"] });
		const error = result.errors.get("gateway");
		expect(error?.message).toContain(message);
		expect(error?.message).toContain('provider "gateway"');
		expect(error?.message).not.toContain("sk-secret");
		expect(fixture.runtime.getModels("gateway").map((model) => model.id)).toEqual(["m"]);
	});

	it("目录响应流中断时报告读取错误", async () => {
		const fixture = await loadProvider(temp.path, { discoverModels: true });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
			start(controller) { controller.error(new Error("connection reset")); },
		})));
		const result = await fixture.runtime.refresh({ allowNetwork: true, providers: ["gateway"] });
		expect(result.errors.get("gateway")?.message).toContain("response cannot be read: connection reset");
	});

	it.each(["timeout", "cancel"] as const)("目录请求 %s 时中止网络请求并保留已有模型", async (mode) => {
		const fixture = await loadProvider(temp.path, { discoverModels: true });
		const controller = new AbortController();
		if (mode === "timeout") vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(controller.signal);
		const started = Promise.withResolvers<AbortSignal>();
		vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) throw new Error("request signal missing");
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			started.resolve(signal);
		}));
		const pending = fixture.runtime.refresh({
			allowNetwork: true, providers: ["gateway"], ...(mode === "cancel" ? { signal: controller.signal } : {}),
		});
		const requestSignal = await started.promise;
		controller.abort();
		const result = await pending;
		expect(requestSignal.aborted).toBe(true);
		if (mode === "timeout") expect(result.errors.get("gateway")?.message).toContain("timed out after 30000ms");
		else expect(result.aborted).toBe(true);
		expect(fixture.runtime.getModels("gateway").map((model) => model.id)).toEqual(["m"]);
	});
});

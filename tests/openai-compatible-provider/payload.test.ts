import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { applyRuntimePayloadConfig, registerOpenAICompatibleProviders } from "../../src/openai-compatible-provider/index.js";
import {
	createExtensionHarness,
	loadConfigFromText,
	normalizeProviders,
	normalizeRuntime,
	providerConfig,
	providerConfigText,
} from "./fixtures.js";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.js";

const temp = useOpenAICompatibleProviderTestSetup();

function responsesPayload(extra: Record<string, unknown> = {}) {
	return { model: "m", input: [], stream: true, ...extra };
}

function runtimeOf(
	providers: Awaited<ReturnType<typeof normalizeProviders>>,
	providerId: string,
) {
	const runtime = providers.find((provider) => provider.id === providerId)?.runtimeModels.get("m");
	if (!runtime) throw new Error(`runtime ${providerId}/m missing`);
	return runtime;
}

describe("openai-compatible-provider payload", () => {
	it("provider extraBody 和 dropParams 仍在原生 samplingParams 之后执行", async () => {
		const { provider, runtime } = await normalizeRuntime(temp.path, {
			extraBody: { custom: true },
			dropParams: ["store"],
			models: [{ id: "m", samplingParams: { temperature: 0.1, top_p: 0.8, top_k: 40 } }],
		}, "vllm");
		expect(provider.models[0]?.samplingParams).toEqual({ temperature: 0.1, top_p: 0.8, top_k: 40 });
		expect(applyRuntimePayloadConfig(
			{ model: "m", messages: [], stream: true, temperature: 0.1, top_p: 0.8, top_k: 40, store: false },
			runtime,
		)).toEqual({
			model: "m",
			messages: [],
			stream: true,
			temperature: 0.1,
			top_p: 0.8,
			top_k: 40,
			custom: true,
		});
	});

	it("原生低层 stream 保留 payload 修改，并转换 Responses 非 OpenAI thinking preset", async () => {
		const config = await loadConfigFromText(temp.path, providerConfigText({
			baseUrl: "https://gateway.example.com/v1",
			api: "openai-responses",
			headers: { "x-model": "provider-header" },
			thinkingPreset: "deepseek",
			maxRetries: 0,
			dropParams: ["store"],
			extraBody: { custom: true },
			models: [{
				id: "m",
				defaultThinkingLevel: "high",
				maxTokens: 8192,
				headers: { "X-Model": "$MODEL_HEADER" },
				samplingParams: { temperature: 0.2, top_k: 40 },
			}],
		}));
		const harness = createExtensionHarness();
		const [provider] = registerOpenAICompatibleProviders(harness.pi, config, path.join(temp.path, "models.jsonc"));
		const model = provider?.getModels()[0];
		if (!provider || !model) throw new Error("provider model missing");
		let requestBody: unknown;
		const modelHeaders: Array<string | null> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			requestBody = JSON.parse(String(init?.body));
			modelHeaders.push(new Headers(init?.headers).get("X-Model"));
			return new Response('{"error":"stop after payload"}', {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		});

		const auth = await provider.auth.apiKey?.resolve({
			ctx: { env: async () => undefined, fileExists: async () => false },
			signal: new AbortController().signal,
		});
		if (!auth) throw new Error("provider auth missing");
		const streamOnce = async (headers: Record<string, string | null>): Promise<void> => {
			for await (const _event of provider.stream(model, {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			}, {
				...(auth.auth.apiKey !== undefined ? { apiKey: auth.auth.apiKey } : {}),
				headers,
				env: { ...auth.env, MODEL_HEADER: "resolved-model-header" },
				reasoningEffort: "high",
				onPayload: () => undefined,
			})) {
			}
		};
		await streamOnce(auth.auth.headers ?? {});
		await streamOnce({ Authorization: null, "X-MODEL": "caller-header" });
		for await (const _event of provider.streamSimple(model, {
			messages: [{ role: "user", content: "test", timestamp: Date.now() }],
		}, {
			...(auth.auth.apiKey !== undefined ? { apiKey: auth.auth.apiKey } : {}),
			...(auth.auth.headers !== undefined ? { headers: auth.auth.headers } : {}),
			env: { ...auth.env, MODEL_HEADER: "resolved-model-header" },
			reasoning: "high",
			samplingParams: { temperature: 0.7 },
		})) {
		}

		expect(requestBody).toMatchObject({
			model: "m",
			temperature: 0.7,
			top_k: 40,
			thinking: { type: "enabled" },
			custom: true,
			max_output_tokens: 8192,
		});
		expect(modelHeaders).toEqual(["resolved-model-header", "caller-header", "resolved-model-header"]);
		expect(requestBody).not.toHaveProperty("reasoning");
		expect(requestBody).not.toHaveProperty("store");
	});


	it.each([
		["openrouter", "high", { reasoning: { effort: "high" } }],
		["deepseek", "high", { thinking: { type: "enabled" } }],
		["together", "off", { reasoning: { enabled: false } }],
		["zai", "high", { thinking: { type: "enabled", clear_thinking: false } }],
		["qwen", "off", { enable_thinking: false }],
		["qwen-chat-template", "high", { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } }],
		["chat-template-enabled", "medium", { chat_template_kwargs: { enable_thinking: true } }],
		["chat-template-enabled", "off", { chat_template_kwargs: { enable_thinking: false } }],
		["chat-template-effort", "high", { chat_template_kwargs: { reasoning_effort: "high" } }],
		["string-thinking", "off", { thinking: "none" }],
	] as const)("Responses API 将 %s thinking preset 编码到 payload", async (thinkingPreset, level, expected) => {
		const { runtime } = await normalizeRuntime(temp.path, {
			api: "openai-responses",
			thinkingPreset,
			models: [{ id: "m", defaultThinkingLevel: level }],
		});
		const payload = applyRuntimePayloadConfig(responsesPayload({
			reasoning: { effort: level },
			include: ["reasoning.encrypted_content"],
		}), runtime, level);
		expect(payload).toMatchObject(expected);
		expect(payload).not.toHaveProperty("include");
	});

	it("Responses chat-template-effort 使用 Pi thinkingLevelMap 上游值", async () => {
		const { provider, runtime } = await normalizeRuntime(temp.path, {
			api: "openai-responses",
			thinkingPreset: "chat-template-effort",
			models: [{
				id: "hy3",
				defaultThinkingLevel: "xhigh",
				thinkingLevelMap: { off: "disabled", xhigh: "max" },
			}],
		}, "thor", "hy3");
		expect(provider.models[0]?.thinkingLevelMap).toEqual({ off: "disabled", xhigh: "max" });
		expect(applyRuntimePayloadConfig(responsesPayload({
			model: "hy3",
			reasoning: { effort: "max" },
			include: ["reasoning.encrypted_content"],
		}), runtime, "xhigh")).toMatchObject({
			chat_template_kwargs: { reasoning_effort: "max" },
		});
	});

	it("Responses openai 保留 Pi payload，none 移除 reasoning 字段", async () => {
		const providers = await normalizeProviders(temp.path, {
			standard: providerConfig({
				api: "openai-responses",
				thinkingPreset: "openai",
				models: [{ id: "m", defaultThinkingLevel: "high" }],
			}, "standard"),
			fixed: providerConfig({
				api: "openai-responses",
				thinkingPreset: "none",
				models: [{ id: "m", defaultThinkingLevel: "high" }],
			}, "fixed"),
		});
		const payload = responsesPayload({
			reasoning: { effort: "high" },
			include: ["reasoning.encrypted_content"],
		});
		expect(applyRuntimePayloadConfig(payload, runtimeOf(providers, "standard"), "high")).toMatchObject({
			reasoning: { effort: "high" },
			include: ["reasoning.encrypted_content"],
		});
		const fixed = applyRuntimePayloadConfig(payload, runtimeOf(providers, "fixed"), "high");
		expect(fixed).not.toHaveProperty("reasoning");
		expect(fixed).not.toHaveProperty("include");
	});

	it("Responses 使用 Pi map 为 ant-ling 和支持 effort 的 deepseek 生成 provider 值", async () => {
		const providers = await normalizeProviders(temp.path, {
			ant: providerConfig({
				api: "openai-responses",
				thinkingPreset: "ant-ling",
				models: [{ id: "m", defaultThinkingLevel: "high", thinkingLevelMap: { high: "max" } }],
			}, "ant"),
			deep: providerConfig({
				api: "openai-responses",
				thinkingPreset: "deepseek",
				models: [{
					id: "m",
					defaultThinkingLevel: "high",
					thinkingLevelMap: { high: "max" },
					compat: { supportsReasoningEffort: true },
				}],
			}, "deep"),
		});
		expect(applyRuntimePayloadConfig(
			responsesPayload(),
			runtimeOf(providers, "ant"),
			"high",
		)).toMatchObject({ reasoning: { effort: "max" } });
		expect(applyRuntimePayloadConfig(
			responsesPayload(),
			runtimeOf(providers, "deep"),
			"high",
		)).toMatchObject({
			thinking: { type: "enabled" },
			reasoning_effort: "max",
		});
	});

	it.each([
		{
			api: "openai-completions",
			field: "messages",
			value: [{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image_url", image_url: { url: "data:image/gif;base64,R0lGODlhAQAB" } },
				],
			}],
		},
		{
			api: "openai-responses",
			field: "input",
			value: [{
				role: "user",
				content: [
					{ type: "input_text", text: "look" },
					{ type: "input_image", image_url: "data:image/gif;base64,R0lGODlhAQAB" },
				],
			}],
		},
	] as const)("保留 $api 的 Pi 原生图片 payload", async ({ api, field, value }) => {
		const { runtime } = await normalizeRuntime(temp.path, {
			api,
			models: [{ id: "m", input: ["text", "image"] }],
		});
		expect(applyRuntimePayloadConfig(
			{ model: "m", [field]: value, stream: true },
			runtime,
		)).toMatchObject({ [field]: value });
	});

	it("provider 原生 headers、provider payload 扩展和 model samplingParams 各自生效", async () => {
		const { provider, runtime } = await normalizeRuntime(temp.path, {
			baseUrl: "https://openrouter.ai/api/v1",
			apiKey: "$OPENROUTER_API_KEY",
			headers: { "HTTP-Referer": "https://example.local" },
			dropParams: ["store"],
			extraBody: { provider: { only: ["openai"] } },
			models: [{
				id: "m",
				dropParams: ["parallel_tool_calls"],
				samplingParams: { top_p: 0.9 },
			}],
		}, "openrouter");
		expect(provider.fallbackRuntime).toBeDefined();
		expect(provider.models[0]?.samplingParams).toEqual({ top_p: 0.9 });
		expect(runtime.dropParams).toEqual(["store", "parallel_tool_calls"]);
		const payload = applyRuntimePayloadConfig(
			{ model: "m", messages: [], stream: true, store: false },
			runtime,
		);
		expect(payload).toMatchObject({ provider: { only: ["openai"] } });
		expect(payload).not.toHaveProperty("top_p");
		expect(payload).not.toHaveProperty("store");
	});
});

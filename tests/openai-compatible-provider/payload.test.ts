import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { Context } from "@earendil-works/pi-ai";
import { applyRuntimePayloadConfig, registerOpenAICompatibleProviders } from "../../src/openai-compatible-provider/index.js";
import { createExtensionHarness, loadConfigFromText, normalizeFromText } from "./fixtures.js";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.js";

const temp = useOpenAICompatibleProviderTestSetup();

describe("openai-compatible-provider payload", () => {
	it("model defaults 补缺失字段，defaults.maxTokens 设置请求上限", async () => {
		const [provider] = await normalizeFromText(temp.path, `{
			"providers": {
				"vllm": {
					"baseUrl": "http://127.0.0.1:8000/v1",
					"apiKey": "EMPTY",
					"compatPreset": "local",
					"models": [{
						"id": "m",
						"defaults": { "temperature": 0.1, "topP": 0.8, "topK": 40, "maxTokens": 8192 }
					}]
				}
			}
		}`);
		const runtime = provider?.runtimeModels.get("m");
		expect(runtime?.defaults).toMatchObject({ temperature: 0.1, topK: 40 });
		if (!runtime) throw new Error("runtime config missing");
		expect(applyRuntimePayloadConfig({ model: "m", messages: [], stream: true, max_tokens: 16384 }, runtime)).toMatchObject({
			model: "m",
			temperature: 0.1,
			top_p: 0.8,
			top_k: 40,
			max_tokens: 8192,
		});
		expect(applyRuntimePayloadConfig({ model: "m", messages: [], stream: true, max_tokens: 4096 }, runtime)).toMatchObject({
			max_tokens: 4096,
		});
	});

	it("原生低层 stream 保留 payload 修改，并转换 Responses 非 OpenAI thinking preset", async () => {
		const config = await loadConfigFromText(temp.path, `{
			"providers": {
				"gateway": {
					"baseUrl": "https://gateway.example.com/v1",
					"apiKey": "EMPTY",
					"api": "openai-responses",
					"headers": { "x-model": "provider-header" },
					"thinkingPreset": "deepseek",
					"maxRetries": 0,
					"dropParams": ["store"],
					"extraBody": { "custom": true },
					"models": [{
						"id": "m",
						"defaultThinkingLevel": "high",
						"maxTokens": 32768,
						"headers": { "X-Model": "$MODEL_HEADER" },
						"defaults": { "temperature": 0.2, "maxTokens": 8192 }
					}]
				}
			}
		}`);
		const harness = createExtensionHarness();
		const [provider] = registerOpenAICompatibleProviders(harness.pi, config, path.join(temp.path, "models.jsonc"));
		const model = provider?.getModels()[0];
		if (!provider || !model) throw new Error("provider model missing");
		let requestBody: unknown;
		const modelHeaders: Array<string | null> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			requestBody = JSON.parse(String(init?.body));
			modelHeaders.push(new Headers(init?.headers).get("X-Model"));
			return new Response('{"error":"stop after payload"}', { status: 400, headers: { "Content-Type": "application/json" } });
		});

		const auth = await provider.auth.apiKey?.resolve({
			ctx: { env: async () => undefined, fileExists: async () => false },
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
				// Consume the terminal error event.
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
		})) {
			// Consume the terminal error event.
		}

		expect(requestBody).toMatchObject({
			model: "m",
			temperature: 0.2,
			thinking: { type: "enabled" },
			custom: true,
			max_output_tokens: 8192,
		});
		expect(modelHeaders).toEqual(["resolved-model-header", "caller-header", "resolved-model-header"]);
		expect(requestBody).not.toHaveProperty("reasoning");
		expect(requestBody).not.toHaveProperty("store");
	});

	it("Responses API 的 defaults.maxTokens 注入为 max_output_tokens", async () => {
		const [provider] = await normalizeFromText(temp.path, `{
			"providers": {
				"gateway": {
					"baseUrl": "https://gateway.example.com/v1",
					"apiKey": "$RESPONSES_GATEWAY_API_KEY",
					"api": "openai-responses",
					"models": [{ "id": "m", "defaults": { "maxTokens": 4096 } }]
				}
			}
		}`);
		const runtime = provider?.runtimeModels.get("m");
		if (!runtime) throw new Error("runtime config missing");
		expect(applyRuntimePayloadConfig({ model: "m", input: [], stream: true }, runtime)).toMatchObject({
			max_output_tokens: 4096,
		});
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
	] as const)("Responses API 将 %s thinking preset 编码到 payload", async (thinking, level, expected) => {
		const [provider] = await normalizeFromText(temp.path, `{
			"providers": {
				"gateway": {
					"baseUrl": "https://gateway.example.com/v1",
					"apiKey": "$RESPONSES_GATEWAY_API_KEY",
					"api": "openai-responses",
					"thinkingPreset": "${thinking}",
					"models": [{ "id": "m", "defaultThinkingLevel": "${level}" }]
				}
			}
		}`);
		const runtime = provider?.runtimeModels.get("m");
		if (!runtime) throw new Error("runtime config missing");
		const payload = applyRuntimePayloadConfig({
			model: "m",
			input: [],
			stream: true,
			reasoning: { effort: level },
			include: ["reasoning.encrypted_content"],
		}, runtime, level);
		expect(payload).toMatchObject(expected);
		expect(payload).not.toHaveProperty("include");
	});

	it("Responses chat-template-effort 使用 Pi thinkingLevelMap 的上游值", async () => {
		const [provider] = await normalizeFromText(temp.path, `{
			"providers": {
				"thor": {
					"baseUrl": "http://thor:11451/v1",
					"apiKey": "EMPTY",
					"api": "openai-responses",
					"thinkingPreset": "chat-template-effort",
					"models": [{
						"id": "hy3",
						"defaultThinkingLevel": "xhigh",
						"thinkingLevelMap": { "off": "disabled", "xhigh": "max" }
					}]
				}
			}
		}`);
		const model = provider?.models?.[0];
		const runtime = provider?.runtimeModels.get("hy3");
		if (!runtime) throw new Error("runtime config missing");
		expect(model?.thinkingLevelMap).toEqual({ off: "disabled", xhigh: "max" });
		expect(applyRuntimePayloadConfig({
			model: "hy3",
			input: [],
			stream: true,
			reasoning: { effort: "max" },
			include: ["reasoning.encrypted_content"],
		}, runtime, "xhigh")).toMatchObject({
			chat_template_kwargs: { reasoning_effort: "max" },
		});
	});

	it("Responses 的 openai 保留 Pi payload，none 移除 Pi reasoning 字段", async () => {
		const providers = await normalizeFromText(temp.path, `{
			"providers": {
				"standard": {
					"baseUrl": "https://standard.example.com/v1",
					"apiKey": "EMPTY",
					"api": "openai-responses",
					"thinkingPreset": "openai",
					"models": [{ "id": "m", "defaultThinkingLevel": "high" }]
				},
				"fixed": {
					"baseUrl": "https://fixed.example.com/v1",
					"apiKey": "EMPTY",
					"api": "openai-responses",
					"thinkingPreset": "none",
					"models": [{ "id": "m", "defaultThinkingLevel": "high" }]
				}
			}
		}`);
		const payload = {
			model: "m",
			input: [],
			stream: true,
			reasoning: { effort: "high" },
			include: ["reasoning.encrypted_content"],
		};
		const standard = providers.find((provider) => provider.id === "standard")?.runtimeModels.get("m");
		const fixed = providers.find((provider) => provider.id === "fixed")?.runtimeModels.get("m");
		if (!standard || !fixed) throw new Error("runtime config missing");
		expect(applyRuntimePayloadConfig(payload, standard, "high")).toMatchObject({
			reasoning: { effort: "high" },
			include: ["reasoning.encrypted_content"],
		});
		expect(applyRuntimePayloadConfig(payload, fixed, "high")).not.toHaveProperty("reasoning");
		expect(applyRuntimePayloadConfig(payload, fixed, "high")).not.toHaveProperty("include");
	});

	it("Responses 使用 Pi map 为 ant-ling 和支持 effort 的 deepseek 生成 provider 值", async () => {
		const providers = await normalizeFromText(temp.path, `{
			"providers": {
				"ant": {
					"baseUrl": "https://ant.example.com/v1",
					"apiKey": "EMPTY",
					"api": "openai-responses",
					"thinkingPreset": "ant-ling",
					"models": [{ "id": "m", "defaultThinkingLevel": "high", "thinkingLevelMap": { "high": "max" } }]
				},
				"deep": {
					"baseUrl": "https://deep.example.com/v1",
					"apiKey": "EMPTY",
					"api": "openai-responses",
					"thinkingPreset": "deepseek",
					"models": [{
						"id": "m",
						"defaultThinkingLevel": "high",
						"thinkingLevelMap": { "high": "max" },
						"compat": { "supportsReasoningEffort": true }
					}]
				}
			}
		}`);
		const ant = providers.find((provider) => provider.id === "ant")?.runtimeModels.get("m");
		const deep = providers.find((provider) => provider.id === "deep")?.runtimeModels.get("m");
		if (!ant || !deep) throw new Error("runtime config missing");
		expect(applyRuntimePayloadConfig({ model: "m", input: [], stream: true }, ant, "high")).toMatchObject({
			reasoning: { effort: "max" },
		});
		expect(applyRuntimePayloadConfig({ model: "m", input: [], stream: true }, deep, "high")).toMatchObject({
			thinking: { type: "enabled" },
			reasoning_effort: "max",
		});
	});

	it("保留 Pi 已转换的 OpenAI 图片 payload，不把图片 base64 拼入文本", async () => {
		const [chatProvider] = await normalizeFromText(temp.path, `{
			"providers": {
				"gateway": {
					"baseUrl": "https://gateway.example.com/v1",
					"apiKey": "EMPTY",
					"models": [{ "id": "m", "input": ["text", "image"] }]
				}
			}
		}`);
		const chatRuntime = chatProvider?.runtimeModels.get("m");
		if (!chatRuntime) throw new Error("runtime config missing");
		const chatMessages = [{
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "image_url", image_url: { url: "data:image/gif;base64,R0lGODlhAQAB" } },
			],
		}];
		expect(applyRuntimePayloadConfig({ model: "m", messages: chatMessages, stream: true }, chatRuntime)).toMatchObject({
			messages: chatMessages,
		});

		const [responsesProvider] = await normalizeFromText(temp.path, `{
			"providers": {
				"gateway": {
					"baseUrl": "https://gateway.example.com/v1",
					"apiKey": "EMPTY",
					"api": "openai-responses",
					"models": [{ "id": "m", "input": ["text", "image"] }]
				}
			}
		}`);
		const responsesRuntime = responsesProvider?.runtimeModels.get("m");
		if (!responsesRuntime) throw new Error("runtime config missing");
		const input = [{
			role: "user",
			content: [
				{ type: "input_text", text: "look" },
				{ type: "input_image", image_url: "data:image/gif;base64,R0lGODlhAQAB" },
			],
		}];
		expect(applyRuntimePayloadConfig({ model: "m", input, stream: true }, responsesRuntime)).toMatchObject({ input });
	});

	it("Responses 保留工具图片，Chat Completions 丢弃工具图片但保留用户图片", async () => {
		const config = await loadConfigFromText(temp.path, `{
			"providers": {
				"chat": {
					"baseUrl": "https://chat.example.com/v1",
					"apiKey": "EMPTY",
					"maxRetries": 0,
					"models": [{ "id": "m", "input": ["text", "image"] }]
				},
				"responses": {
					"baseUrl": "https://responses.example.com/v1",
					"apiKey": "EMPTY",
					"api": "openai-responses",
					"maxRetries": 0,
					"models": [{ "id": "m", "input": ["text", "image"] }]
				}
			}
		}`);
		const harness = createExtensionHarness();
		const providers = registerOpenAICompatibleProviders(harness.pi, config, path.join(temp.path, "models.jsonc"));
		const requests = new Map<string, unknown>();
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			requests.set(String(input), JSON.parse(String(init?.body)));
			return new Response('{"error":"stop after payload"}', {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		});
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "look" },
						{ type: "image", data: "dXNlcg==", mimeType: "image/png" },
					],
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "webfetch",
					content: [
						{ type: "text", text: "page" },
						{ type: "image", data: "dG9vbA==", mimeType: "image/png" },
					],
					isError: false,
					timestamp: 2,
				},
			],
		};
		for (const provider of providers) {
			const model = provider.getModels()[0];
			if (!model) throw new Error(`provider ${provider.id} model missing`);
			for await (const _event of provider.stream(model, context, { apiKey: "EMPTY" })) {
				// Consume the terminal error event after capturing the request.
			}
		}

		const chatRequest = requests.get("https://chat.example.com/v1/chat/completions");
		expect(chatRequest).toMatchObject({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "look" },
						{ type: "image_url", image_url: { url: "data:image/png;base64,dXNlcg==" } },
					],
				},
				{ role: "tool", content: "page", tool_call_id: "call_1" },
			],
		});
		expect(JSON.stringify(chatRequest)).not.toContain("dG9vbA==");
		expect(JSON.stringify(chatRequest)).not.toContain("Attached image(s) from tool result:");

		expect(requests.get("https://responses.example.com/v1/responses")).toMatchObject({
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: "look" },
						{ type: "input_image", image_url: "data:image/png;base64,dXNlcg==" },
					],
				},
				{
					type: "function_call_output",
					call_id: "call_1",
					output: [
						{ type: "input_text", text: "page" },
						{ type: "input_image", image_url: "data:image/png;base64,dG9vbA==" },
					],
				},
			],
		});
	});

	it("provider 原生 headers 与扩展 payload 字段直接配置，model 字段覆盖或追加", async () => {
		const [provider] = await normalizeFromText(temp.path, `{
			"providers": {
				"openrouter": {
					"baseUrl": "https://openrouter.ai/api/v1",
					"apiKey": "$OPENROUTER_API_KEY",
					"headers": { "HTTP-Referer": "https://example.local" },
					"dropParams": ["store"],
					"extraBody": { "provider": { "only": ["openai"] } },
					"models": [{ "id": "m", "dropParams": ["parallel_tool_calls"], "extraBody": { "top_p": 0.9 } }]
				}
			}
		}`);
		expect(provider?.fallbackRuntime).toBeDefined();
		const runtime = provider?.runtimeModels.get("m");
		expect(runtime?.dropParams).toEqual(["store", "parallel_tool_calls"]);
		if (!runtime) throw new Error("runtime config missing");
		expect(applyRuntimePayloadConfig({ model: "m", messages: [], stream: true, store: false }, runtime)).toMatchObject({
			provider: { only: ["openai"] },
			top_p: 0.9,
		});
		expect(applyRuntimePayloadConfig({ model: "m", messages: [], stream: true, store: false }, runtime)).not.toHaveProperty("store");
	});
});

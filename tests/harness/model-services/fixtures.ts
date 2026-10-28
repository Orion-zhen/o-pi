import { writeFile } from "node:fs/promises";
import path from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, type Context, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { loadModelsConfig } from "../../../src/harness/model-services/config.ts";
import type { ModelsConfig } from "../../../src/harness/model-services/schema.ts";

export function providerConfig(overrides: Record<string, unknown> = {}, providerId = "gateway"): Record<string, unknown> {
	return {
		baseUrl: `https://${providerId}.example.test/v1`, api: "openai-completions",
		apiKey: "fixture", models: [{ id: "m" }], ...overrides,
	};
}

export async function loadProvider(dir: string, overrides: Record<string, unknown> = {}, providerId = "gateway") {
	await loadConfigFromText(dir, JSON.stringify({ providers: { [providerId]: providerConfig(overrides, providerId) } }));
	const runtime = await ModelRuntime.create({
		modelsPath: path.join(dir, "models.json"), credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false, refreshOnCreate: false,
	});
	const error = runtime.getError();
	if (error) throw new Error(error);
	const provider = runtime.getProvider(providerId);
	if (!provider) throw new Error("provider missing");
	return { provider, runtime };
}

/** 捕获 SDK 请求，校验界面展示和消息转换。会话扩展由真实会话测试覆盖。 */
export async function capturePayload(
	{ provider, runtime }: Awaited<ReturnType<typeof loadProvider>>,
	options: SimpleStreamOptions = {},
	{ modelId = "m", context = { messages: [{ role: "user", content: "test", timestamp: 0 }] } }:
	{ modelId?: string; context?: Context } = {},
): Promise<unknown> {
	const model = provider.getModels().find((entry) => entry.id === modelId);
	if (!model) throw new Error(`model ${modelId} missing`);
	let payload: unknown;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		payload = JSON.parse(String(init?.body));
		return new Response('{"error":"stop after payload"}', { status: 400 });
	});
	for await (const _event of runtime.streamSimple(model, context, options)) {}
	if (payload === undefined) throw new Error("request was not sent");
	return payload;
}

export async function loadConfigFromText(dir: string, text: string): Promise<ModelsConfig> {
	const file = path.join(dir, "models.json");
	await writeFile(file, text);
	const config = await loadModelsConfig(file);
	if (!config) throw new Error("config unexpectedly missing");
	return config;
}

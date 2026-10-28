import { expect, it, vi } from "vitest";
import { providerConfig } from "./fixtures.ts";
import { startModelSession, saveModelService } from "./session-fixture.ts";
import { useModelServicesTestSetup } from "./test-support.ts";

const temp = useModelServicesTestSetup();

it("混合 OpenAI、Anthropic 会话保留原生协议，重载不残留模型或请求选项", async () => {
	const config = providerConfig({ extraBody: { metadata: { user_id: "test" } }, models: [
		{ id: "m", api: "openai-completions" },
		{ id: "claude", api: "anthropic-messages", baseUrl: "https://models.test" },
	] });
	const fetch = vi.spyOn(globalThis, "fetch");
	const runtime = await startModelSession(temp.path, config);
	expect(fetch).not.toHaveBeenCalled();
	const sent: unknown[] = [];
	fetch.mockImplementation(async (_input, init) => {
		sent.push(JSON.parse(String(init?.body)));
		return new Response('{"error":{"message":"stop after payload","code":400,"status":"INVALID_ARGUMENT"}}', { status: 400 });
	});
	try {
		for (const id of ["m", "claude"]) {
			const model = runtime.services.modelRuntime.getModel("gateway", id);
			if (!model) throw new Error("model missing");
			await runtime.session.setModel(model);
			await runtime.session.prompt("test");
			expect(sent.at(-1)).toHaveProperty("metadata.user_id", "test");
			expect(sent.at(-1)).toHaveProperty("messages");
			if (id === "claude") expect(sent.at(-1)).toHaveProperty("max_tokens", 16384);
		}
		expect(sent).toHaveLength(2);
		expect(runtime.services.modelRuntime.getRegisteredNativeProvider("gateway")).toBeUndefined();
		await saveModelService(temp.path, providerConfig());
		await runtime.session.reload();
		await runtime.services.modelRuntime.refresh({ allowNetwork: false });
		expect(runtime.services.modelRuntime.getModels("gateway").map(({ id }) => id)).toEqual(["m"]);
		const model = runtime.services.modelRuntime.getModel("gateway", "m");
		if (!model) throw new Error("model missing after reload");
		await runtime.session.setModel(model);
		await runtime.session.prompt("reloaded");
		expect(sent).toHaveLength(3);
		expect(sent.at(-1)).not.toHaveProperty("metadata");
	} finally { await runtime.dispose(); }
});

it("Google 会话通过 SDK 参数发送扩展配置", async () => {
	const runtime = await startModelSession(temp.path, providerConfig({
		api: "google-generative-ai", baseUrl: "https://models.test/v1beta",
		extraBody: { config: { temperature: 0.8 } }, models: [{ id: "gemini-2.5-flash" }],
	}), { modelId: "gemini-2.5-flash" });
	const requests: unknown[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		requests.push(JSON.parse(String(init?.body)));
		return new Response('{"error":{"message":"stop after payload","code":400,"status":"INVALID_ARGUMENT"}}', { status: 400 });
	});
	try {
		await runtime.session.prompt("test");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ generationConfig: { temperature: 0.8 }, contents: expect.any(Array) });
	} finally { await runtime.dispose(); }
});

it("内置 Anthropic 仅添加请求字段时不要求重复连接信息，不替换 OAuth 和原生目录", async () => {
	const runtime = await startModelSession(temp.path, {
		apiKey: "fixture", extraBody: { metadata: { user_id: "test" } },
		modelOverrides: { "claude-sonnet-4-6": { defaultThinkingLevel: "high" } },
	}, { providerId: "anthropic", modelId: "claude-sonnet-4-6" });
	try {
		const models = runtime.services.modelRuntime;
		const original = models.getProvider("anthropic");
		expect(original?.auth.oauth).toBeDefined();
		expect(original?.refreshModels).toBeDefined();
		expect(models.getRegisteredNativeProvider("anthropic")).toBeUndefined();
		await runtime.session.reload();
		expect(models.getProvider("anthropic")).toBe(original);
		const model = models.getModel("anthropic", "claude-sonnet-4-6");
		const other = models.getModels("anthropic").find((entry) => entry.id !== model?.id);
		if (!model || !other) throw new Error("native model missing");
		await runtime.session.setModel(other);
		await runtime.session.setModel(model);
		expect(runtime.session.thinkingLevel).toBe("high");
	} finally { await runtime.dispose(); }
});

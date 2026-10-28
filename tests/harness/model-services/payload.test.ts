import { expect, it, vi } from "vitest";
import { providerConfig } from "./fixtures.ts";
import { startModelSession } from "./session-fixture.ts";
import { useModelServicesTestSetup } from "./test-support.ts";

const temp = useModelServicesTestSetup();

it.each(["openai-completions", "openai-responses"] as const)("%s 会话请求应用扩展选项，保留 SDK 认证和模型请求头", async (api) => {
	vi.stubEnv("MODEL_KEY", "sk-test");
	vi.stubEnv("MODEL_ACCOUNT", "account");
	const runtime = await startModelSession(temp.path, providerConfig({
		api, apiKey: "$MODEL_KEY", headers: { "X-Account": "$MODEL_ACCOUNT", "X-Value": "provider" },
		dropParams: ["store"], extraBody: { temperature: 0.8, custom: true, top_p: 0.9, top_k: 40 },
		models: [{ id: "m", maxTokens: 8192, samplingParams: { temperature: 0.2 }, headers: { "X-Value": "model" }, dropParams: ["top_p"] }],
		modelOverrides: { m: { dropParams: ["top_k"] } },
	}));
	const requests: { headers: Headers; body: unknown }[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
		return new Response('{"error":"stop after payload"}', { status: 400 });
	});
	try {
		await runtime.session.prompt("test");
		expect(requests).toHaveLength(1);
		const request = requests[0];
		expect(request?.headers.get("Authorization")).toBe("Bearer sk-test");
		expect(request?.headers.get("X-Account")).toBe("account");
		expect(request?.headers.get("X-Value")).toBe("model");
		expect(request?.body).toMatchObject({ model: "m", stream: true, temperature: 0.8, custom: true, top_p: 0.9 });
		expect(request?.body).toHaveProperty(api === "openai-responses" ? "max_output_tokens" : "max_completion_tokens", 8192);
		for (const key of ["store", "top_k"]) expect(request?.body).not.toHaveProperty(key);
	} finally { await runtime.dispose(); }
});

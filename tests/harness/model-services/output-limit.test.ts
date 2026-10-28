import { expect, it, vi } from "vitest";
import { startModelSession, saveModelService } from "./session-fixture.ts";
import { providerConfig } from "./fixtures.ts";
import { useModelServicesTestSetup } from "./test-support.ts";

const temp = useModelServicesTestSetup();
const protocols = [
	{ api: "openai-completions", field: "max_completion_tokens", compat: { maxTokensField: "max_completion_tokens" } },
	{ api: "openai-completions", field: "max_tokens", compat: { maxTokensField: "max_tokens" } },
	{ api: "openai-responses", field: "max_output_tokens", compat: {} },
];
const tokenFields = ["max_tokens", "max_completion_tokens", "max_output_tokens"];

it.each(protocols)("$field 留空不发送，重载后应用模型定义及覆盖，清空后恢复不限", async ({ api, field, compat }) => {
	const provider = providerConfig({ api, compat });
	const runtime = await startModelSession(temp.path, provider);
	const requests: unknown[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		requests.push(JSON.parse(String(init?.body)));
		return new Response('{"error":"stop after payload"}', { status: 400 });
	});
	const request = async (expected: number | undefined) => {
		const count = requests.length;
		await runtime.session.prompt("test");
		expect(requests).toHaveLength(count + 1);
		const payload = requests.at(-1);
		if (expected === undefined) for (const key of tokenFields) expect(payload).not.toHaveProperty(key);
		else expect(payload).toHaveProperty(field, expected);
	};
	const reload = async (models: unknown[], modelOverrides: Record<string, unknown> = {}) => {
		await saveModelService(temp.path, { ...provider, models, modelOverrides });
		await runtime.session.reload();
		// 与 GUI 重载一致：刷新模型目录，并替换会话持有的旧模型对象。
		await runtime.services.modelRuntime.refresh({ allowNetwork: false });
		const model = runtime.services.modelRuntime.getModel("gateway", "m");
		if (!model) throw new Error("model missing after reload");
		runtime.session.agent.state.model = model;
	};
	try {
		await request(undefined);
		await reload([{ id: "m", maxTokens: 8192 }]);
		await request(8192);
		await reload([{ id: "m", maxTokens: 8192 }], { m: { maxTokens: 4096 } });
		await request(4096);
		await reload([{ id: "m", maxTokens: 8192 }], { m: {} });
		await request(8192);
		await reload([{ id: "m" }]);
		await request(undefined);
	} finally { await runtime.dispose(); }
});

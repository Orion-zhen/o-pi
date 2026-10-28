import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { loadModelsConfig } from "../../../src/harness/model-services/config.ts";
import { providerConfig } from "./fixtures.ts";
import { startModelSession } from "./session-fixture.ts";
import { useModelServicesTestSetup } from "./test-support.ts";

const temp = useModelServicesTestSetup();

it("仓库示例配置与当前 schema 同步", async () => {
	const config = await loadModelsConfig(path.resolve("agent/models.example.jsonc"));
	if (!config) throw new Error("example config missing");
	expect(config.providers["llama-cpp"]).toHaveProperty("compat.thinkingFormat", "chat-template");
	expect(config.providers["responses-demo"]?.api).toBe("openai-responses");
});

it("不存在 models.json 时不加载配置", async () => {
	expect(await loadModelsConfig(path.join(temp.path, "models.json"))).toBeUndefined();
});

it("接受带 UTF-8 BOM 的 models.json", async () => {
	const configPath = path.join(temp.path, "bom-models.json");
	await writeFile(configPath, '\uFEFF{ "providers": { "local": { "baseUrl": "http://127.0.0.1:8000/v1", "api": "openai-completions", "dropParams": ["store"], "models": [{"id":"model"}] } } }');
	await expect(loadModelsConfig(configPath)).resolves.toMatchObject({ providers: { local: { models: [{ id: "model" }] } } });
});

it("配置文件读取失败时转换为配置错误", async () => {
	await expect(loadModelsConfig(temp.path)).rejects.toThrow();
});

it("会话恢复保留思考等级，用户切换模型时才应用定义及覆盖层的默认值", async () => {
	const runtime = await startModelSession(temp.path, providerConfig({
		models: [
			{ id: "m", reasoning: true, defaultThinkingLevel: "minimal" },
			{ id: "other", reasoning: true, defaultThinkingLevel: "low" },
		],
		modelOverrides: { other: { defaultThinkingLevel: "high" } },
	}));
	try {
		expect(runtime.session.thinkingLevel).toBe("off");
		for (const [id, expected] of [["other", "high"], ["m", "minimal"]] as const) {
			const model = runtime.services.modelRuntime.getModel("gateway", id);
			if (!model) throw new Error("model missing");
			await runtime.session.setModel(model);
			expect(runtime.session.thinkingLevel).toBe(expected);
		}
	} finally { await runtime.dispose(); }
});

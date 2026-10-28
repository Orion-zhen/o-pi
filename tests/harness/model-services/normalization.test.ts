import { expect, it } from "vitest";
import { loadConfigFromText, providerConfig } from "./fixtures.ts";
import { useModelServicesTestSetup } from "./test-support.ts";

const temp = useModelServicesTestSetup();

it.each([
	["服务请求体覆盖消息", { extraBody: { messages: [] } }],
	["模型删除消息", { models: [{ id: "m", dropParams: ["messages"] }] }],
	["覆盖层删除工具", { modelOverrides: { m: { dropParams: ["tools"] } } }],
	["无效输出上限", { models: [{ id: "m", maxTokens: 0 }] }],
	["无效默认思考等级", { models: [{ id: "m", defaultThinkingLevel: "turbo" }] }],
])("加载配置时拒绝%s，不泄露密钥", async (_name, overrides) => {
	const result = loadConfigFromText(temp.path, JSON.stringify({ providers: {
		gateway: providerConfig({ apiKey: "sk-secret", ...overrides }),
	} }));
	await expect(result).rejects.toThrow();
	await expect(result).rejects.not.toThrow("sk-secret");
});

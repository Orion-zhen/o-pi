import { describe, expect, it } from "vitest";
import { loadProvider } from "./fixtures.ts";
import { useOpenAICompatibleProviderTestSetup } from "./test-support.ts";

const temp = useOpenAICompatibleProviderTestSetup();
const invalidConfigs = [
	["provider core dropParams", { dropParams: ["model"] }],
	["model core dropParams", { models: [{ id: "m", dropParams: ["messages"] }] }],
	["provider core extraBody", { extraBody: { tools: [] } }],
	["override core dropParams", { modelOverrides: { m: { dropParams: ["tools"] } } }],
	["fractional maxRetries", { maxRetries: 0.5 }],
	["zero maxTokens", { models: [{ id: "m", maxTokens: 0 }] }],
	["zero override maxTokens", { modelOverrides: { m: { maxTokens: 0 } } }],
	["missing baseUrl", { baseUrl: undefined }],
	["unknown provider thinking format", { compat: { thinkingFormat: "unknown" } }],
	["unknown model thinking format", { models: [{ id: "m", compat: { thinkingFormat: "unknown" } }] }],
	["unknown default thinking level", { models: [{ id: "m", defaultThinkingLevel: "turbo" }] }],
] as const;

describe("openai-compatible-provider normalization", () => {
	it("启用扩展后保留 SDK 应用的原生模型元数据及覆盖", async () => {
		const { provider } = await loadProvider(temp.path, {
			dropParams: ["store"], compat: { supportsStore: true },
			models: [{
				id: "m", api: "openai-responses", baseUrl: "https://responses.test/v1",
				reasoning: true, contextWindow: 200000, maxTokens: 8192, input: ["text", "image"],
				inputLimits: { images: { resize: { maxWidth: 2400 } } }, promptCache: { short: 300 },
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
				compat: { supportsToolSearch: true },
			}],
			modelOverrides: { m: { name: "Native Model", maxTokens: 4096 } },
		});
		expect(provider.getModels()[0]).toMatchObject({
			id: "m", name: "Native Model", api: "openai-responses", baseUrl: "https://responses.test/v1",
			reasoning: true, contextWindow: 200000, maxTokens: 4096, input: ["text", "image"],
			inputLimits: { images: { resize: { maxWidth: 2400 } } }, promptCache: { short: 300 },
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
			compat: { supportsStore: true, supportsToolSearch: true },
		});
	});

	it.each(invalidConfigs)("拒绝 %s 且不泄露密钥", async (_name, overrides) => {
		const result = loadProvider(temp.path, { apiKey: "sk-secret", dropParams: ["store"], ...overrides });
		await expect(result).rejects.toThrow();
		await expect(result).rejects.not.toThrow("sk-secret");
	});
});

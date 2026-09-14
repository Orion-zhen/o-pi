import { beforeEach, describe, expect, it, vi } from "vitest";

const loads = vi.hoisted(() => ({ o200k: 0, cl100k: 0 }));

vi.mock("gpt-tokenizer/encoding/o200k_base", () => {
	loads.o200k += 1;
	return { countTokens: (input: string) => input.length };
});

vi.mock("gpt-tokenizer/encoding/cl100k_base", () => {
	loads.cl100k += 1;
	return { countTokens: (input: string) => input.length };
});

describe("token counter loading", () => {
	beforeEach(() => {
		loads.o200k = 0;
		loads.cl100k = 0;
		vi.resetModules();
	});

	it("导入和启发式计数不加载 BPE，精确计数时才按编码器加载一次", async () => {
		const { countTextTokens } = await import("../../src/harness/token-counter.ts");

		expect(loads).toEqual({ o200k: 0, cl100k: 0 });
		await expect(countTextTokens("abc中文", { modelId: "deepseek-chat" })).resolves.toMatchObject({ method: "deepseek_ratio" });
		expect(loads).toEqual({ o200k: 0, cl100k: 0 });

		await Promise.all([
			countTextTokens("first", { provider: "openai", modelId: "gpt-5" }),
			countTextTokens("second", { provider: "openai", modelId: "gpt-5" }),
		]);
		expect(loads).toEqual({ o200k: 1, cl100k: 0 });

		await countTextTokens("third", { provider: "dashscope", modelId: "qwen-max" });
		await countTextTokens("fourth", { provider: "dashscope", modelId: "qwen-max" });
		expect(loads).toEqual({ o200k: 1, cl100k: 1 });
	});
});

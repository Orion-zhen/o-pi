import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeCodeFile } from "../../../src/harness/code-index/parser.ts";
import { SyntaxAnalysisAbortedError } from "../../../src/harness/syntax-tree/parser.ts";

const text = "function run() { return 1; }\n";
afterEach(() => vi.restoreAllMocks());

describe("code parser failure boundaries", () => {
	it("语法预算耗尽返回错误状态，下一次仍能正常解析", async () => {
		await analyzeCodeFile("main.ts", text);
		const clock = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(251);
		try {
			await expect(analyzeCodeFile("main.ts", text)).resolves.toMatchObject({ status: "error", units: [] });
		} finally {
			clock.mockRestore();
		}
		await expect(analyzeCodeFile("main.ts", text)).resolves.toMatchObject({ status: "parsed", units: [expect.objectContaining({ name: "run" })] });
	});

	it("用户取消向上传播，不转换为解析失败", async () => {
		await expect(analyzeCodeFile("main.ts", text, AbortSignal.abort())).rejects.toBeInstanceOf(SyntaxAnalysisAbortedError);
	});
});

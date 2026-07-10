import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePipeline, tokenize } from "../../src/subagent/commands.js";
import { formatFileHandoff, formatResultForContext, getRunDir, limitHandoff, persistResult, sanitizeFileName, truncateText } from "../../src/subagent/output.js";
import type { SubagentRunResult } from "../../src/subagent/types.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-subagent-output-");

describe("subagent commands", () => {
	it("解析引号和管道", () => {
		expect(tokenize(`scout "inspect auth" 'and tests'`)).toEqual(["scout", "inspect auth", "and tests"]);
		expect(parsePipeline(`scout "inspect auth" | reviewer 'inspect tests'`)).toEqual({
			tasks: [
				{ agent: "scout", task: "inspect auth" },
				{ agent: "reviewer", task: "inspect tests" },
			],
		});
	});

	it("语法错误明确", () => {
		expect(parsePipeline(`scout`)).toEqual({ error: "Invalid segment: scout" });
		expect(() => tokenize(`"unterminated`)).toThrow("Unclosed quote");
	});
});

describe("subagent output", () => {
	it("Unicode 截断安全且标记截断", () => {
		const result = truncateText("a😀b😀c", 4);
		expect(result.text).toContain("a😀b😀");
		expect(result.text).toContain("truncated");
	});

	it("handoff 限制和文件名清理", () => {
		expect(limitHandoff("abcdef", 3)).toContain("abc");
		expect(sanitizeFileName('a/b:c*"d')).toBe("a_b_c_d");
	});

	it("file 输出只给路径和读取指引", () => {
		const result = { ...runResult(), output: "secret full output", outputFile: "/workspace/.pi/subagents/runs/run-1/scout-1.md" };

		const contextText = formatResultForContext(result, "file", 1200);
		expect(contextText).toContain("Subagent result saved to:");
		expect(contextText).toContain(result.outputFile);
		expect(contextText).toContain("Read the file for the full result.");
		expect(contextText).not.toContain("Preview:");
		expect(contextText).not.toContain("secret full output");

		const handoffText = formatFileHandoff(result);
		expect(handoffText).toContain("Previous subagent result:");
		expect(handoffText).toContain(result.outputFile);
		expect(handoffText).toContain("Read the file for the full result.");
		expect(handoffText).not.toContain("Preview:");
		expect(handoffText).not.toContain("secret full output");
	});

	it("默认运行日志写入项目 .pi/subagents", async () => {
		const dir = temp.path;
		await mkdir(path.join(dir, ".pi"), { recursive: true });
		const expectedRunDir = path.join(dir, ".pi", "subagents", "runs", "run-1");

		expect(getRunDir(dir, "run-1")).toBe(expectedRunDir);

		const result = await persistResult(runResult(), {
			cwd: dir,
			runId: "run-1",
			index: 0,
			outputMode: "file",
			maxInlineOutputChars: 1200,
		});
		const outputFile = result.outputFile;
		if (outputFile === undefined) throw new Error("persistResult did not return outputFile");

		expect(outputFile).toBe(path.join(expectedRunDir, "scout-1.md"));
		await expect(stat(outputFile)).resolves.toMatchObject({ isFile: expect.any(Function) });
		await expect(stat(path.join(dir, "subagents", "runs", "run-1", "scout-1.md"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});

function runResult(): SubagentRunResult {
	return {
		runId: "run-1",
		mode: "parallel",
		agent: "scout",
		source: "user",
		task: "inspect",
		cwd: "/workspace",
		tools: ["read"],
		attempts: 1,
		exitCode: 0,
		output: "done",
		durationMs: 10,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, turns: 0 },
		events: [],
	};
}

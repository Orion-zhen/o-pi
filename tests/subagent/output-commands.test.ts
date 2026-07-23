import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePipeline, tokenize } from "../../src/subagent/commands.js";
import { exceedsTokenLimit, formatFileHandoff, formatResultForContext, getRunDir, persistResult, sanitizeFileName } from "../../src/subagent/output.js";
import { countTextTokensSync } from "../../src/token-counter.js";
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
	it("清理输出文件名", () => {
		expect(sanitizeFileName('a/b:c*"d')).toBe("a_b_c_d");
	});

	it("自动 inline 短输出，超限时只给一行文件路径", () => {
		const outputFile = "/workspace/.pi/subagents/runs/run-1/scout-1.md";
		const result = { ...runResult(), output: "secret full output", outputFile };
		const outputTokens = countTextTokensSync(result.output).tokens;

		expect(formatResultForContext(result, outputTokens)).toBe(result.output);
		const contextText = formatResultForContext(result, outputTokens - 1);
		expect(contextText).toBe(`Subagent scout produced too much output for inline return; full output saved to ${outputFile}.`);
		expect(contextText).not.toContain("\n");
		expect(contextText).not.toContain("secret full output");
		expect(exceedsTokenLimit(result.output, outputTokens)).toBe(false);
		expect(exceedsTokenLimit(result.output, outputTokens - 1)).toBe(true);

		const handoffText = formatFileHandoff(result);
		expect(handoffText).toContain(outputFile);
		expect(handoffText).not.toContain("\n");
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
		contextMode: "isolated",
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

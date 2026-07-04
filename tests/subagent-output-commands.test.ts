import { describe, expect, it } from "vitest";
import { parsePipeline, tokenize } from "../src/subagent/commands.js";
import { limitHandoff, sanitizeFileName, truncateText } from "../src/subagent/output.js";

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
});

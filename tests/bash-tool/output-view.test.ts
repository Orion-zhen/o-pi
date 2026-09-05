import path from "node:path";
import { describe, expect, it } from "vitest";

import { takeHeadBytes, takeTailBytes } from "../../src/bash-tool/utf8.js";
import { cleanForModel, createBashOutputView } from "../../src/bash-tool/output-view.js";
import { bashToolConfig } from "./fixture.js";
import type { BashOutputFormat, BashRunStatus } from "../../src/bash-tool/types.js";

const config = bashToolConfig();
const fullOutputPath = path.join("o-pi", "bash", "s", "t.log");

function view(text: string, overrides: Partial<Parameters<typeof createBashOutputView>[0]> = {}) {
	return createBashOutputView({
		preview: { kind: "complete", bytes: Buffer.from(text) },
		status: "exited",
		exitCode: 0,
		durationMs: 420,
		totalBytes: Buffer.byteLength(text),
		totalLines: text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
		logPath: fullOutputPath,
		captureComplete: true,
		binary: false,
		limits: config.limits,
		...overrides,
	});
}

describe("bash output view", () => {
	it("小输出完整返回", () => {
		const result = view("one\ntwo\n");
		expect(result.details.output_state).toBe("complete");
		expect(result.keepLog).toBe(false);
		expect(result.content.split("\n", 1)[0]).toBe("[exit=0 duration=0.42s output=complete]");
		expect(result.content).toContain("one\ntwo\n");
	});

	it("成功大输出按 head/tail 截断并保留日志路径", () => {
		const limits = { ...config.limits, success_output_bytes: 120 };
		const text = Array.from({ length: 80 }, (_, index) => `line ${index}`).join("\n");
		const result = view(text, { limits });
		expect(result.details.output_state).toBe("truncated");
		expect(result.details.full_output_path).toBe(fullOutputPath);
		expect(result.content.split("\n", 1)[0]).toBe(`[exit=0 duration=0.42s output=truncated full=${fullOutputPath}]`);
		expect(result.content).toContain("line 0");
		expect(result.content).toContain("line 79");
		expect(result.content).toMatch(/\[\.\.\. \d+ lines omitted \.\.\.\]/);
		expect(result.details.returned_bytes).toBeLessThanOrEqual(limits.success_output_bytes);
	});

	it("失败大输出保留诊断窗口", () => {
		const limits = { ...config.limits, failure_output_bytes: 220 };
		const text = Array.from({ length: 40 }, (_, index) => (index === 20 ? "Fatal error: boom" : `line ${index}`)).join("\n");
		const result = view(text, { status: "exited", exitCode: 2, limits });
		expect(result.keepLog).toBe(true);
		expect(result.details.output_state).toBe("truncated");
		expect(result.content).toContain("Fatal error: boom");
		expect(result.content).toContain("line 18");
		expect(result.content).toContain("line 23");
	});

	it("head、诊断窗口、tail 重叠时不重复", () => {
		const limits = { ...config.limits, failure_output_bytes: 220 };
		const text = Array.from({ length: 40 }, (_, index) => index === 1 ? "error: near head" : index === 38 ? "error: near tail" : `line ${index}`).join("\n");
		const result = view(text, { status: "exited", exitCode: 1, limits });
		expect(result.details.output_state).toBe("truncated");
		expect(result.content.match(/error: near head/g)).toHaveLength(1);
		expect(result.content.match(/error: near tail/g)).toHaveLength(1);
		expect(result.content.match(/\nline 0\n/g)).toHaveLength(1);
		expect(result.content.match(/\nline 39(?:\n|$)/g)).toHaveLength(1);
	});

	it("连续重复行折叠，非连续重复行不折叠", () => {
		const compacted = view("Retrying\nRetrying\nRetrying\nok\n");
		expect(compacted.details.output_state).toBe("compacted");
		expect(compacted.content).toContain("[same line repeated 2 more times]");
		expect(compacted.content).not.toContain(`full=${fullOutputPath}`);

		const separate = view("Retrying\nother\nRetrying\n");
		expect(separate.content).not.toContain("same line repeated");
	});

	it("完整失败输出保留日志但不提示读取完整日志", () => {
		const result = view("bad\n", { status: "exited", exitCode: 1 });
		expect(result.keepLog).toBe(true);
		expect(result.details.full_output_path).toBe(fullOutputPath);
		expect(result.details.output_state).toBe("complete");
		expect(result.content).not.toContain(`full=${fullOutputPath}`);
	});

	it("回车进度只展示最终状态", () => {
		const result = view("Downloading 1%\rDownloading 2%\rDownloading 100%\n");
		expect(result.details.output_state).toBe("compacted");
		expect(result.content).toContain("Downloading 100% [2 progress updates omitted]");
		expect(result.content).not.toContain("Downloading 1%");
	});

	it("JSON、XML、diff 不执行破坏性重复行折叠", () => {
		const json = view(`{"a":1}\n{"a":1}\n{"a":1}\n`);
		expect(json.details.output_format).toBe<BashOutputFormat>("json");
		expect(json.content).not.toContain("same line repeated");

		const xml = view("<root>\n<x />\n<x />\n<x />\n</root>\n");
		expect(xml.details.output_format).toBe("xml");
		expect(xml.content).not.toContain("same line repeated");

		const diff = view("--- a\n+++ b\n@@\n-a\n+a\n");
		expect(diff.details.output_format).toBe("diff");
	});

	it("ANSI 被移除，控制字符可见化", () => {
		const result = view("\u001b[31mred\u001b[0m\u0000\n");
		expect(result.content).toContain("red\\x00");
		expect(result.content).not.toContain("\u001b[31m");
	});

	it("超长单行受预算限制", () => {
		const limits = { ...config.limits, success_output_bytes: 100 };
		const result = view("x".repeat(1000), { limits });
		expect(result.details.returned_bytes).toBeLessThanOrEqual(100);
		expect(result.details.output_state).toBe("truncated");
	});

	it("空行压缩正确", () => {
		const result = view("a\n\n\n\nb\n");
		expect(result.details.output_state).toBe("compacted");
		expect(result.content).toContain("a\n\n\nb");
		expect(result.content).not.toContain("a\n\n\n\nb");
	});

	it("省略标记和行数统计明确", () => {
		const limits = { ...config.limits, success_output_bytes: 90 };
		const result = view(Array.from({ length: 30 }, (_, index) => `l${index}`).join("\n"), { limits });
		expect(result.content).toMatch(/\[\.\.\. \d+ lines omitted \.\.\.\]/);
		expect(result.details.total_lines).toBe(30);
		expect(result.details.returned_lines).toBeGreaterThan(0);
	});

	it.each([
		["json", JSON.stringify({ values: Array.from({ length: 1_000 }, (_, index) => `值😀${index}`) })],
		["xml", `<root>${"<value>你好😀</value>".repeat(1_000)}</root>`],
		["diff", `diff --git a/file b/file\n${"+你好😀\n".repeat(1_000)}`],
		["binary", "\u0000你好😀".repeat(1_000)],
	] as const)("%s 预览的标签、标记和多字节正文共同满足预算", (format, text) => {
		const limits = { ...config.limits, success_output_bytes: 1_024 };
		const result = view(text, { limits, binary: format === "binary" });
		expect(result.details).toMatchObject({ output_state: "truncated", output_format: format });
		expect(result.content).toContain(format === "binary" ? "binary/text preview" : `this is not a complete ${format.toUpperCase()} document`);
		expect(result.details.returned_bytes).toBeLessThanOrEqual(1_024);
		expect(result.content).not.toContain("�");
	});

	it("诊断很多时先保留首尾错误，不把它们交给通用裁剪器", () => {
		const limits = { ...config.limits, failure_output_bytes: 1_024 };
		const text = Array.from({ length: 400 }, (_, index) => `error ${index}: 你好😀`).join("\n");
		const result = view(text, { exitCode: 1, limits });
		expect(result.content).toContain("error 0:");
		expect(result.content).toContain("error 399:");
		expect(result.details.returned_bytes).toBeLessThanOrEqual(1_024);
		expect(result.content).not.toContain("�");
	});

	it("UTF-8 byte 截断不拆分 astral 字符", () => {
		expect(takeHeadBytes("a😀b", 5)).toBe("a😀");
		expect(takeHeadBytes("a😀b", 4)).toBe("a");
		expect(takeTailBytes("a😀b", 5)).toBe("😀b");
		expect(takeTailBytes("a😀b", 4)).toBe("b");
	});

	it("cleanForModel 不破坏正常 Unicode", () => {
		expect(cleanForModel("你好\t世界\n", "text").text).toBe("你好\t世界\n");
	});

	it("状态头支持 timeout 和 aborted", () => {
		for (const status of ["timed_out", "aborted"] as BashRunStatus[]) {
			const firstLine = view("partial", { status }).content.split("\n", 1)[0];
			expect(firstLine).toBe(`[${status === "timed_out" ? "timeout" : "aborted"} duration=0.42s output=complete]`);
			expect(firstLine).not.toMatch(/\b(?:lines|bytes)=/);
		}
	});
});

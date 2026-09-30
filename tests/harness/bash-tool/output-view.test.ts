import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBashOutputView } from "../../../src/harness/bash-tool/output-view.ts";
import { bashToolConfig } from "./fixture.ts";

const config = bashToolConfig();
const logPath = path.join("o-pi", "bash", "s", "t.log");
function view(text: string, overrides: Partial<Parameters<typeof createBashOutputView>[0]> = {}) {
	return createBashOutputView({
		preview: { kind: "complete", bytes: Buffer.from(text) }, status: "exited", exitCode: 0,
		durationMs: 420, totalBytes: Buffer.byteLength(text),
		totalLines: text.length === 0 ? 0 : text.split("\n").length - Number(text.endsWith("\n")),
		logPath, captureComplete: true, binary: false, limits: config.limits, ...overrides,
	});
}

describe("Bash 模型输出", () => {
	it.each([
		["完整输出", "one\ntwo\n", "complete", "one\ntwo\n"],
		["连续重复行", "Retrying\nRetrying\nRetrying\nok\n", "compacted", "Retrying"],
		["回车进度", "Downloading 1%\rDownloading 2%\rDownloading 100%\n", "compacted", "Downloading 100%"],
		["空行", "a\n\n\n\nb\n", "compacted", "a\n\n\nb"],
		["控制字符", "\u001b[31mred\u001b[0m\u0000\n", "complete", "red\\x00"],
		["Unicode", "你好\t世界\n", "complete", "你好\t世界\n"],
	])("%s", (_name, text, state, expected) => {
		const result = view(text);
		expect(result.details.output_state).toBe(state);
		expect(result.content).toContain(expected);
		expect(result.content).not.toContain(`full=${logPath}`);
	});

	it.each([
		["text", "Retrying\nother\nRetrying\n"],
		["json", '{"a":1}\n{"a":1}\n{"a":1}\n'],
		["xml", "<root>\n<x />\n<x />\n<x />\n</root>\n"],
		["diff", "--- a\n+++ b\n@@\n-a\n+a\n"],
	])("不破坏 %s 结构或非连续重复行", (format, text) => {
		const result = view(text);
		expect(result.details.output_format).toBe(format);
	});

	it.each([0, 1])("exit=%i 的长输出保留首尾，失败时额外保留诊断", (exitCode) => {
		const text = Array.from({ length: 80 }, (_, index) => index === 40 ? "Fatal error: boom" : `line ${index}`).join("\n");
		const result = view(text, { exitCode, limits: { ...config.limits, success_output_bytes: 220, failure_output_bytes: 220 } });
		expect(result.details).toMatchObject({ output_state: "truncated", full_output_path: logPath, total_lines: 80 });
		expect(result.content).toContain("line 0");
		expect(result.content).toContain("line 79");
		if (exitCode) expect(result.content).toContain("Fatal error: boom");
		expect(result.details.returned_bytes).toBeLessThanOrEqual(220);
	});

	it("诊断窗口和首尾重叠时只输出一次，完整失败输出仍保留日志", () => {
		const text = Array.from({ length: 40 }, (_, i) => i === 1 || i === 38 ? `error: ${i}` : `line ${i}`).join("\n");
		const result = view(text, { exitCode: 1, limits: { ...config.limits, failure_output_bytes: 220 } });
		for (const marker of ["error: 1", "error: 38", "line 0\n", "line 39"]) expect(result.content.split(marker)).toHaveLength(2);
		const complete = view("bad\n", { exitCode: 1 });
		expect(complete.keepLog).toBe(true);
		expect(complete.content).not.toContain(`full=${logPath}`);
	});

	it.each([
		["text", "你好😀".repeat(1000)],
		["json", JSON.stringify({ values: Array.from({ length: 1000 }, (_, i) => `值😀${i}`) })],
		["xml", `<root>${"<value>你好😀</value>".repeat(1000)}</root>`],
		["diff", `diff --git a/file b/file\n${"+你好😀\n".repeat(1000)}`],
		["binary", "\u0000你好😀".repeat(1000)],
	])("%s 截断包含标签预算且不拆分 Unicode", (format, text) => {
		const result = view(text, { binary: format === "binary", limits: { ...config.limits, success_output_bytes: 1024 } });
		expect(result.details).toMatchObject({ output_state: "truncated", output_format: format });
		expect(result.details.returned_bytes).toBeLessThanOrEqual(1024);
		expect(result.content).not.toContain("�");
	});

});

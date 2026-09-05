import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { executeBashCommand } from "../../src/bash-tool/bash-tool.js";
import { bashToolConfig } from "./fixture.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-bash-output-");
let logDirectory: string | undefined;
afterEach(async () => {
	if (logDirectory !== undefined) await rm(logDirectory, { recursive: true, force: true });
	logDirectory = undefined;
});

async function execute(output: Buffer, options: { successBudget?: number; failureBudget?: number; liveBudget?: number; exitCode?: number } = {}) {
	const config = bashToolConfig();
	config.python_venv_paths = [];
	config.limits.success_output_bytes = options.successBudget ?? 32_768;
	config.limits.failure_output_bytes = options.failureBudget ?? 1_024;
	config.limits.live_output_bytes = options.liveBudget ?? 1_024;
	const sessionId = path.basename(temp.path);
	logDirectory = path.join(os.tmpdir(), "o-pi", "bash", sessionId);
	return executeBashCommand({ command: "output-fixture" }, {
		cwd: temp.path,
		session: { sessionId },
		toolCallId: "output",
		config,
		branch: [],
		operations: {
			async exec(_command, _cwd, { onData }) {
				onData(output);
				return { exitCode: options.exitCode ?? 0 };
			},
		},
	});
}

describe("bash 输出链路", () => {
	it("成功预算大于失败预算时，不提前裁剪预算内输出", async () => {
		const text = `${"a".repeat(3_000)}MID${"z".repeat(3_000)}`;
		const result = await execute(Buffer.from(text));
		expect(result.details.output_state).toBe("complete");
		expect(result.content.slice(result.content.indexOf("\n") + 1)).toBe(text);
		expect(result.details.full_output_path).toBeUndefined();
	});

	it("无效 UTF-8 解码膨胀时，预算内的完整文本不会被隐式裁剪", async () => {
		const output = Buffer.alloc(4_000, 0xff);
		const result = await execute(output);
		expect(result.details).toMatchObject({ output_state: "complete", total_bytes: 4_000, returned_bytes: 12_000 });
		expect(result.content.slice(result.content.indexOf("\n") + 1)).toBe(output.toString("utf8"));
	});

	it("无效 UTF-8 解码后超预算时标记截断并保留原始字节", async () => {
		const output = Buffer.alloc(1_000, 0xff);
		const result = await execute(output, { successBudget: 1_024 });
		expect(result.details.output_state).toBe("truncated");
		expect(result.details.returned_bytes).toBeLessThanOrEqual(1_024);
		const logPath = result.details.full_output_path;
		if (logPath === undefined) throw new Error("missing log path");
		expect(await readFile(logPath)).toEqual(output);
	});

	it("头尾压缩后即使小于预算，也明确显示原始缺口", async () => {
		const text = "same\n".repeat(2_000);
		const result = await execute(Buffer.from(text), { successBudget: 1_024 });
		expect(result.details.output_state).toBe("truncated");
		expect(result.content).toContain("5904 raw bytes outside preview");
		expect(result.content.match(/same line repeated/g)).toHaveLength(2);
		expect(result.details.returned_bytes).toBeLessThan(1_024);
	});

	it("原始窗口截在多字节字符中间时，不制造替代字符", async () => {
		const text = `HEAD\n${"x".repeat(2_042)}😀${"m".repeat(5_000)}😀${"y".repeat(2_037)}😀\nTAIL`;
		const result = await execute(Buffer.from(text), { successBudget: 1_024 });
		expect(result.details.output_state).toBe("truncated");
		expect(result.content).toContain("HEAD\n");
		expect(result.content.endsWith("😀\nTAIL")).toBe(true);
		expect(result.content).not.toContain("�");
		expect(result.details.returned_bytes).toBeLessThanOrEqual(1_024);
	});

	it("结构化输出即使清理后很短，原始预览有缺口时仍声明不完整", async () => {
		const text = `{"start":1,${"\u001b[31m".repeat(2_000)}"end":2}`;
		const result = await execute(Buffer.from(text), { successBudget: 1_024 });
		expect(result.details).toMatchObject({ output_state: "truncated", output_format: "json" });
		expect(result.content).toContain("this is not a complete JSON document");
		expect(result.content).toContain("raw bytes outside preview");
		expect(result.details.returned_bytes).toBeLessThanOrEqual(1_024);
	});

	it("长上下文超预算时优先保留错误行，不在选中诊断后再次裁剪", async () => {
		const text = Array.from({ length: 40 }, (_, index) => index === 20 ? "Fatal error: boom" : `line ${index} ${"x".repeat(180)}`).join("\n");
		const result = await execute(Buffer.from(text), { exitCode: 1, liveBudget: 8_192 });
		expect(result.content).toContain("Fatal error: boom");
		expect(result.details.returned_bytes).toBeLessThanOrEqual(1_024);
		expect(result.content).not.toContain("output truncated to byte budget");
	});
});

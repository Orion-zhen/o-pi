import { WriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bashToolConfig, runBash } from "./fixture.ts";
import { deferredVoid } from "../../helpers/async.ts";
import { useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("o-pi-bash-capture-");
let logDirectory: string | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
	if (logDirectory !== undefined) await rm(logDirectory, { recursive: true, force: true });
	logDirectory = undefined;
});

async function execute(exec: BashOperations["exec"]) {
	const sessionId = path.basename(temp.path);
	logDirectory = path.join(os.tmpdir(), "o-pi", "bash", sessionId);
	return runBash({ command: "capture-fixture" }, {
		cwd: temp.path,
		sessionId,
		toolCallId: "capture",
		limits: bashToolConfig().limits,
		operations: { exec },
	});
}

async function expectLogDeleted(): Promise<void> {
	if (logDirectory === undefined) throw new Error("execution did not create a log directory");
	await expect(stat(path.join(logDirectory, "capture.log"))).rejects.toMatchObject({ code: "ENOENT" });
}

describe("bash 日志生命周期", () => {
	it("后端写入后异常时释放文件流、删除日志并保留原始异常", async () => {
		const error = new Error("operation failed");
		await expect(execute(async (_command, _cwd, { onData }) => {
			onData(Buffer.from("partial output\n"));
			throw error;
		})).rejects.toBe(error);
		await expectLogDeleted();
	});

	it("日志无法创建时，仍执行命令并返回截断原因", async () => {
		logDirectory = path.join(os.tmpdir(), "o-pi", "bash", path.basename(temp.path));
		await mkdir(path.join(logDirectory, "capture.log"), { recursive: true });
		const result = await execute(async (_command, _cwd, { onData }) => {
			onData(Buffer.from(`HEAD${"x".repeat(60_000)}TAIL`));
			return { exitCode: 0 };
		});
		expect(result.details).toMatchObject({ exit_code: 0, output_state: "truncated", capture_complete: false, full_output_error: expect.any(String) });
		expect(result.structuredContent.full_output_error).toBe(result.details.full_output_error);
		expect(result.details).not.toHaveProperty("full_output_path");
		expect(result.structuredContent).not.toHaveProperty("full_output_path");
		expect(result.content).toContain("full_error=");
		expect(result.content).toContain("HEAD");
		expect(result.content).toContain("TAIL");
	});

	it("磁盘写满后仍返回后续输出和命令退出码，并清理残缺日志", async () => {
		const ioError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
		const failedWrite = deferredVoid();
		// 在 Node 文件流的写入边界注入错误，保留真实的 error、close 和文件句柄生命周期。
		vi.spyOn(WriteStream.prototype, "_write").mockImplementationOnce((_chunk, _encoding, callback) => {
			callback(ioError);
			failedWrite.resolve();
		});
		const result = await execute(async (_command, _cwd, { onData }) => {
			onData(Buffer.from("partial output\n"));
			await failedWrite.promise;
			// 错误必须发生在 exec 仍未结束时，而不是 finish 才开始监听。
			await new Promise<void>((resolve) => setImmediate(resolve));
			onData(Buffer.from("output after disk failure\n"));
			return { exitCode: 7 };
		});
		expect(result.structuredContent).toMatchObject({ exit_code: 7, output: "partial output\noutput after disk failure\n", full_output_error: "disk full" });
		expect(result.structuredContent).not.toHaveProperty("full_output_path");
		await expectLogDeleted();
	});
});

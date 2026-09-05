import { WriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeBashCommand } from "../../src/bash-tool/bash-tool.js";
import { bashToolConfig } from "./fixture.js";
import { deferredVoid } from "../helpers/async.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-bash-capture-");
let logDirectory: string | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
	if (logDirectory !== undefined) await rm(logDirectory, { recursive: true, force: true });
	logDirectory = undefined;
});

async function execute(exec: BashOperations["exec"], signal?: AbortSignal) {
	const config = bashToolConfig();
	config.python_venv_paths = [];
	const sessionId = path.basename(temp.path);
	logDirectory = path.join(os.tmpdir(), "o-pi", "bash", sessionId);
	return executeBashCommand({ command: "capture-fixture" }, {
		cwd: temp.path,
		session: { sessionId },
		toolCallId: "capture",
		config,
		branch: [],
		operations: { exec },
		...(signal === undefined ? {} : { signal }),
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

	it.each(["exit", "throw", "abort"] as const)("执行期间发生异步写入错误，后端 %s 后仍完成清理", async (ending) => {
		const ioError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
		const operationError = new Error("operation failed");
		const failedWrite = deferredVoid();
		const controller = new AbortController();
		// 在 Node 文件流的写入边界注入错误，保留真实的 error、close 和文件句柄生命周期。
		vi.spyOn(WriteStream.prototype, "_write").mockImplementationOnce((_chunk, _encoding, callback) => {
			callback(ioError);
			failedWrite.resolve();
		});
		await expect(execute(async (_command, _cwd, { onData }) => {
			onData(Buffer.from("partial output\n"));
			await failedWrite.promise;
			// 错误必须发生在 exec 仍未结束时，而不是 finish 才开始监听。
			await new Promise<void>((resolve) => setImmediate(resolve));
			onData(Buffer.from("output after disk failure\n"));
			if (ending === "abort") controller.abort();
			if (ending !== "exit") throw operationError;
			return { exitCode: 0 };
		}, controller.signal)).rejects.toBe(ending === "throw" ? operationError : ioError);
		await expectLogDeleted();
	});
});

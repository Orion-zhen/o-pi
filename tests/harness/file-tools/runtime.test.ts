import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileToolsHost } from "../../../src/harness/file-tools/runtime/host.ts";
import { NodeNativeFileSystem } from "../../../src/harness/filesystem/platform/node/native-filesystem.ts";
import { piTextDiffGenerator } from "../../../src/harness/file-tools/pi/ports/text-diff.ts";
import { editFile } from "../../../src/harness/file-tools/edit/command.ts";
import { writeFile as writeCommand } from "../../../src/harness/file-tools/write/command.ts";
import { isFailed } from "../../../src/harness/file-tools/shared/result.ts";
import { readWorkspaceFile } from "../../helpers/read-tool.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("o-pi-file-host-");
preserveEnv("PI_FILE_TOOLS_CONFIG", "PI_FILE_TOOLS_PROJECT_CONFIG", "PI_FILE_TOOLS_PROJECT_ROOT");
let host: FileToolsHost;
beforeEach(() => {
	host = new FileToolsHost();
	process.env.PI_FILE_TOOLS_CONFIG = path.join(temp.path, "file-tools.jsonc");
	delete process.env.PI_FILE_TOOLS_PROJECT_CONFIG;
	delete process.env.PI_FILE_TOOLS_PROJECT_ROOT;
});
afterEach(() => { host.dispose(); vi.restoreAllMocks(); });

async function open(sessionId: string, signal?: AbortSignal) {
	const result = await host.open({ cwd: temp.path, sessionId, ...(signal ? { signal } : {}) });
	if (isFailed(result)) throw new Error(result.error.message);
	return result;
}

async function edit(sessionId: string, file: string) {
	const opened = await open(sessionId);
	try {
		return await editFile({ path: file, edits: [{ old: "before", new: "after" }] }, { ...opened, diff: piTextDiffGenerator });
	} finally { opened.dispose(); }
}

describe("文件工具会话", () => {
	it("配置错误可修复，失败打开不妨碍后续调用", async () => {
		await writeFile(process.env.PI_FILE_TOOLS_CONFIG ?? "", '{"limits":{"ls_entries":0}}');
		await expect(host.open({ cwd: temp.path, sessionId: "one" })).resolves.toMatchObject({ error: { code: "CONFIG_ERROR" } });
		await writeFile(process.env.PI_FILE_TOOLS_CONFIG ?? "", "{}");
		(await open("one")).dispose();
	});

	it.skipIf(process.platform === "win32")("同会话按真实路径共享已读版本，不同会话隔离", async () => {
		await writeFile(path.join(temp.path, "file.txt"), "before");
		await symlink(path.join(temp.path, "file.txt"), path.join(temp.path, "alias.txt"));
		await readWorkspaceFile(temp.path, { path: "file.txt" }, { host, sessionId: "one" });
		await expect(edit("two", "alias.txt")).resolves.toMatchObject({ error: { code: "READ_REQUIRED" } });
		await expect(edit("one", "alias.txt")).resolves.toMatchObject({ status: "applied" });
		expect(await readFile(path.join(temp.path, "file.txt"), "utf8")).toBe("after");
	});

	it("提交后取消仍记录版本，下一次 edit 不会误报未读", async () => {
		const controller = new AbortController();
		const replace = NodeNativeFileSystem.prototype.atomicReplace;
		vi.spyOn(NodeNativeFileSystem.prototype, "atomicReplace").mockImplementation(async function (this: NodeNativeFileSystem, file, bytes, options) {
			const result = await replace.call(this, file, bytes, options);
			controller.abort();
			return result;
		});
		const opened = await open("one", controller.signal);
		try {
			await expect(writeCommand({ path: "file.txt", content: "before" }, { ...opened, diff: piTextDiffGenerator }))
				.resolves.toMatchObject({ status: "written" });
		} finally { opened.dispose(); }
		await expect(edit("one", "file.txt")).resolves.toMatchObject({ status: "applied" });
	});

	it("关闭宿主拒绝在途打开和新调用", async () => {
		const opening = host.open({ cwd: temp.path, sessionId: "one" });
		host.dispose();
		await expect(opening).resolves.toMatchObject({ error: { code: "OPERATION_ABORTED" } });
		await expect(host.open({ cwd: temp.path, sessionId: "two" })).resolves.toMatchObject({ error: { code: "OPERATION_ABORTED" } });
	});
});

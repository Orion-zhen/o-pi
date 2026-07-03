import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editWorkspace } from "../src/file-tools/edit-tool.js";
import { listWorkspaceDirectory } from "../src/file-tools/ls-tool.js";
import { readWorkspaceFile } from "../src/file-tools/read-tool.js";
import { sha256Version } from "../src/file-tools/text-file.js";
import type { LsSuccess, ToolOutcome } from "../src/file-tools/types.js";
import { SecurityService } from "../src/security/runtime/security-service.js";

let workspace: string;
let outside: string;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "o-pi-workspace-"));
	outside = await mkdtemp(path.join(os.tmpdir(), "o-pi-outside-"));
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
});

function expectLsSuccess(result: ToolOutcome<LsSuccess>): LsSuccess {
	if ("status" in result) throw new Error(`ls failed: ${result.error.code}`);
	return result;
}

function standardPermission() {
	return { permission: { securityService: new SecurityService({ workspaceRoot: workspace, agentDir: workspace, projectTrusted: false }) } };
}

describe("ls", () => {
	it("列出空目录并支持 . 表示 workspace root", async () => {
		await mkdir(path.join(workspace, "empty"));
		expect(await listWorkspaceDirectory(workspace, { path: "empty" })).toMatchObject({
			path: "empty",
			entries: [],
			truncated: false,
		});
		expect(await listWorkspaceDirectory(workspace, { path: "." })).toMatchObject({
			path: ".",
			entries: [{ name: "empty", path: "empty", type: "directory" }],
			truncated: false,
		});
	});

	it("只返回直属成员、dotfiles、结构化 type 和相对规范化 path", async () => {
		await mkdir(path.join(workspace, "src", "nested"), { recursive: true });
		await writeFile(path.join(workspace, "src", "index.ts"), "export const x = 1;\n");
		await writeFile(path.join(workspace, "src", ".env.example"), "A=1\n");
		await writeFile(path.join(workspace, "src", "nested", "child.ts"), "child\n");

		const result = await listWorkspaceDirectory(workspace, { path: "src/." });
		expect(result).toMatchObject({
			path: "src",
			entries: [
				{ name: "nested", path: "src/nested", type: "directory" },
				{ name: ".env.example", path: "src/.env.example", type: "file" },
				{ name: "index.ts", path: "src/index.ts", type: "file" },
			],
			truncated: false,
		});
		expect(JSON.stringify(result)).not.toContain("export const x");
		expect(JSON.stringify(result)).not.toContain("child");
		expect(JSON.stringify(result)).not.toContain("size_bytes");
		expect(JSON.stringify(result)).not.toContain("mtime");
	});

	it("按类型和大小写折叠名称稳定排序，且不受创建顺序影响", async () => {
		await writeFile(path.join(workspace, "b.txt"), "");
		await mkdir(path.join(workspace, "zDir"));
		await writeFile(path.join(workspace, "A.txt"), "");
		await mkdir(path.join(workspace, "aDir"));

		const first = await listWorkspaceDirectory(workspace, { path: "." });
		const second = await listWorkspaceDirectory(workspace, { path: "." });
		expect(first).toEqual(second);
		expect(first).toMatchObject({
			entries: [
				{ name: "aDir", type: "directory" },
				{ name: "zDir", type: "directory" },
				{ name: "A.txt", type: "file" },
				{ name: "b.txt", type: "file" },
			],
		});
	});

	it("区分不存在、普通文件、路径逃逸、绝对路径、glob 和受保护路径", async () => {
		await writeFile(path.join(workspace, "file.txt"), "");
		await mkdir(path.join(workspace, ".git"));
		expect(await listWorkspaceDirectory(workspace, { path: "missing" })).toMatchObject({
			status: "failed",
			error: { code: "PATH_NOT_FOUND", path: "missing" },
		});
		expect(await listWorkspaceDirectory(workspace, { path: "file.txt" })).toMatchObject({
			status: "failed",
			error: { code: "NOT_A_DIRECTORY", path: "file.txt" },
		});
		expect(await listWorkspaceDirectory(workspace, { path: "../outside" })).toMatchObject({
			status: "failed",
			error: { code: "SECURITY_DENIED" },
		});
		expect(await listWorkspaceDirectory(workspace, { path: path.join(outside, "x") })).toMatchObject({
			status: "failed",
			error: { code: "SECURITY_DENIED" },
		});
		expect(await listWorkspaceDirectory(workspace, { path: "C:escape" })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_PATH" },
		});
		expect(await listWorkspaceDirectory(workspace, { path: "src/*.ts" })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_PATH" },
		});
		expect(await listWorkspaceDirectory(workspace, { path: ".git" })).toMatchObject({
			status: "failed",
			error: { code: "PERMISSION_DENIED" },
		});
	});

	it("父目录隐藏 blocked 项并保留普通 dotfile", async () => {
		await mkdir(path.join(workspace, ".git"));
		await writeFile(path.join(workspace, ".gitignore"), "dist\n");
		const result = await listWorkspaceDirectory(workspace, { path: "." });
		expect(result).toMatchObject({
			entries: [{ name: ".gitignore", path: ".gitignore", type: "file" }],
			blocked_entries: 1,
		});
		expect("ignored" in expectLsSuccess(result).entries[0]!).toBe(false);
	});

	it("父目录中的 symlink 返回 symlink，不按目标类型改写", async () => {
		await mkdir(path.join(workspace, "real-dir"));
		try {
			await symlink(path.join(workspace, "real-dir"), path.join(workspace, "link-dir"), "dir");
		} catch {
			return;
		}
		const result = await listWorkspaceDirectory(workspace, { path: "." });
		expect(result).toMatchObject({
			entries: [
				{ name: "real-dir", path: "real-dir", type: "directory" },
				{ name: "link-dir", path: "link-dir", type: "symlink" },
			],
		});
	});

	it("访问 workspace 内目录 symlink 会解析 realpath，workspace 外 symlink 会失败", async () => {
		await mkdir(path.join(workspace, "real-dir"));
		await mkdir(path.join(outside, "outside-dir"));
		try {
			await symlink(path.join(workspace, "real-dir"), path.join(workspace, "inside-link"), "dir");
			await symlink(path.join(outside, "outside-dir"), path.join(workspace, "outside-link"), "dir");
		} catch {
			return;
		}
		expect(await listWorkspaceDirectory(workspace, { path: "inside-link" })).toMatchObject({
			path: "inside-link",
			entries: [],
			truncated: false,
		});
		expect(await listWorkspaceDirectory(workspace, { path: "outside-link" })).toMatchObject({
			status: "failed",
			error: { code: "SECURITY_DENIED" },
		});
	});

	it("symlink cycle 不递归、不挂起", async () => {
		await mkdir(path.join(workspace, "loop"));
		try {
			await symlink(path.join(workspace, "loop"), path.join(workspace, "loop", "self"), "dir");
		} catch {
			return;
		}
		expect(await listWorkspaceDirectory(workspace, { path: "loop" })).toMatchObject({
			entries: [{ name: "self", path: "loop/self", type: "symlink" }],
			truncated: false,
		});
	});

	it("大目录截断时显式返回数量并保持稳定排序", async () => {
		await mkdir(path.join(workspace, "many"));
		for (let index = 249; index >= 0; index -= 1) {
			await writeFile(path.join(workspace, "many", `f${String(index).padStart(3, "0")}.txt`), "");
		}
		const result = await listWorkspaceDirectory(workspace, { path: "many" });
		expect(result).toMatchObject({
			path: "many",
			truncated: true,
			returned_entries: 200,
			total_entries: 250,
			continuation_hint: "List a more specific subdirectory.",
		});
		const success = expectLsSuccess(result);
		expect(success.entries).toHaveLength(200);
		expect(success.entries[0]).toMatchObject({ name: "f000.txt" });
		expect(success.entries[199]).toMatchObject({ name: "f199.txt" });
		expect(await listWorkspaceDirectory(workspace, { path: "many" })).toEqual(result);
	});

	it("无副作用：调用前后目录、文件内容和 mtime 不变", async () => {
		const file = path.join(workspace, "a.txt");
		await writeFile(file, "one\n");
		const oldDate = new Date("2020-01-01T00:00:00Z");
		await utimes(file, oldDate, oldDate);
		const beforeNames = await readdir(workspace);
		const beforeBytes = await readFile(file);
		const beforeStat = await stat(file);
		await listWorkspaceDirectory(workspace, { path: "." });
		expect(await readdir(workspace)).toEqual(beforeNames);
		expect(await readFile(file)).toEqual(beforeBytes);
		expect((await stat(file)).mtimeMs).toBe(beforeStat.mtimeMs);
	});

	it.skipIf(process.platform === "win32")("权限不足目录返回 PERMISSION_DENIED", async () => {
		const locked = path.join(workspace, "locked");
		await mkdir(locked);
		await chmod(locked, 0o000);
		try {
			expect(await listWorkspaceDirectory(workspace, { path: "locked" })).toMatchObject({
				status: "failed",
				error: { code: "PERMISSION_DENIED", path: "locked" },
			});
		} finally {
			await chmod(locked, 0o700);
		}
	});

	it("端到端 ls -> ls -> read，并保持 ls/read 类型边界", async () => {
		await mkdir(path.join(workspace, "src"));
		await writeFile(path.join(workspace, "src", "main.ts"), "export const main = 1;\n");

		const root = await listWorkspaceDirectory(workspace, { path: "." });
		expect(root).toMatchObject({ entries: [{ name: "src", path: "src", type: "directory" }] });
		const src = await listWorkspaceDirectory(workspace, { path: "src" });
		expect(src).toMatchObject({ entries: [{ name: "main.ts", path: "src/main.ts", type: "file" }] });
		const main = await readWorkspaceFile(workspace, { path: "src/main.ts" });
		expect(main).toMatchObject({ content: "export const main = 1;\n" });
		if (!("version" in main)) throw new Error("read failed");
		expect(main.version).toBe(sha256Version(Buffer.from("export const main = 1;\n")));

		expect(await listWorkspaceDirectory(workspace, { path: "src/main.ts" })).toMatchObject({
			status: "failed",
			error: { code: "NOT_A_DIRECTORY" },
		});
		expect(await readWorkspaceFile(workspace, { path: "src" })).toMatchObject({
			status: "failed",
			error: { code: "NOT_A_FILE" },
		});
	});
});

describe("read", () => {
	it("读取完整 UTF-8 文件并返回版本和元数据", async () => {
		await writeFile(path.join(workspace, "a.txt"), "one\ntwo\n", "utf8");
		const result = await readWorkspaceFile(workspace, { path: "a.txt" });
		expect(result).toMatchObject({
			path: "a.txt",
			content: "one\ntwo\n",
			start_line: 1,
			end_line: 2,
			total_lines: 2,
			encoding: "utf-8",
			newline: "lf",
			truncated: false,
			bom: false,
		});
		if ("version" in result) expect(result.version).toBe(sha256Version(Buffer.from("one\ntwo\n")));
	});

	it("按行范围读取且不把行号写进 content", async () => {
		await writeFile(path.join(workspace, "a.txt"), "one\ntwo\nthree\n", "utf8");
		const result = await readWorkspaceFile(workspace, { path: "a.txt", start_line: 2, end_line: 2 });
		expect(result).toMatchObject({ content: "two\n", start_line: 2, end_line: 2, total_lines: 3 });
	});

	it("处理空文件、无尾部换行、CRLF 和 UTF-8 BOM", async () => {
		await writeFile(path.join(workspace, "empty.txt"), "");
		await writeFile(path.join(workspace, "nonewline.txt"), "one");
		await writeFile(path.join(workspace, "crlf.txt"), "one\r\ntwo\r\n");
		await writeFile(path.join(workspace, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\n")]));
		expect(await readWorkspaceFile(workspace, { path: "empty.txt" })).toMatchObject({
			content: "",
			total_lines: 0,
			newline: "none",
		});
		expect(await readWorkspaceFile(workspace, { path: "nonewline.txt" })).toMatchObject({
			content: "one",
			total_lines: 1,
			newline: "none",
		});
		expect(await readWorkspaceFile(workspace, { path: "crlf.txt" })).toMatchObject({ newline: "crlf" });
		expect(await readWorkspaceFile(workspace, { path: "bom.txt" })).toMatchObject({ content: "one\n", bom: true });
	});

	it("截断时返回 continuation", async () => {
		await writeFile(path.join(workspace, "big.txt"), `${Array.from({ length: 2100 }, (_, i) => `l${i}`).join("\n")}\n`);
		const result = await readWorkspaceFile(workspace, { path: "big.txt" });
		expect(result).toMatchObject({ truncated: true, continuation: { start_line: 2001 }, end_line: 2000 });
	});

	it("拒绝非法范围、缺失文件、二进制和非法 UTF-8", async () => {
		await writeFile(path.join(workspace, "binary.bin"), Buffer.from([0, 1, 2]));
		await writeFile(path.join(workspace, "bad.txt"), Buffer.from([0xc3, 0x28]));
		expect(await readWorkspaceFile(workspace, { path: "missing.txt" })).toMatchObject({
			status: "failed",
			error: { code: "FILE_NOT_FOUND" },
		});
		expect(await readWorkspaceFile(workspace, { path: "binary.bin" })).toMatchObject({
			status: "failed",
			error: { code: "BINARY_FILE_UNSUPPORTED" },
		});
		expect(await readWorkspaceFile(workspace, { path: "bad.txt" })).toMatchObject({
			status: "failed",
			error: { code: "ENCODING_UNSUPPORTED" },
		});
		expect(await readWorkspaceFile(workspace, { path: "bad.txt", start_line: 0 })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_PATH" },
		});
	});

	it("拒绝路径逃逸和符号链接逃逸", async () => {
		await writeFile(path.join(outside, "secret.txt"), "secret");
		expect(await readWorkspaceFile(workspace, { path: "../x.txt" })).toMatchObject({
			status: "failed",
			error: { code: "SECURITY_DENIED" },
		});
		expect(await readWorkspaceFile(workspace, { path: path.join(outside, "secret.txt") })).toMatchObject({
			status: "failed",
			error: { code: "SECURITY_DENIED" },
		});
		try {
			await symlink(path.join(outside, "secret.txt"), path.join(workspace, "link.txt"));
			expect(await readWorkspaceFile(workspace, { path: "link.txt" })).toMatchObject({
				status: "failed",
				error: { code: "SECURITY_DENIED" },
			});
		} catch {
			// Windows 未启用符号链接权限时跳过该断言。
		}
	});

	it("内容变化会改变 version，read 不修改内容或 mtime", async () => {
		const file = path.join(workspace, "a.txt");
		await writeFile(file, "one\n");
		const oldDate = new Date("2020-01-01T00:00:00Z");
		await utimes(file, oldDate, oldDate);
		const first = await readWorkspaceFile(workspace, { path: "a.txt" });
		const afterReadBytes = await readFile(file);
		const afterReadStat = await stat(file);
		await writeFile(file, "two\n");
		const second = await readWorkspaceFile(workspace, { path: "a.txt" });
		expect(afterReadBytes.toString("utf8")).toBe("one\n");
		expect(afterReadStat.mtimeMs).toBeLessThan(oldDate.getTime() + 1000);
		if ("version" in first && "version" in second) expect(first.version).not.toBe(second.version);
	});
});

describe("edit", () => {
	it("拒绝旧字符串协议和非法 operation schema", async () => {
		const legacyField = "pa" + "tch";
		const legacyText = ["*** Begin", "Patch\n*** End", "Patch"].join(" ");
		expect(await editWorkspace(workspace, { [legacyField]: legacyText })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_OPERATION" },
		});
		expect(await editWorkspace(workspace, { operations: [] })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_OPERATION" },
		});
		expect(await editWorkspace(workspace, { operations: [{ type: "unknown" }] })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_OPERATION", operation_index: 0 },
		});
		expect(await editWorkspace(workspace, { operations: [{ type: "create_file", path: "a.txt" }] })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_OPERATION", operation_index: 0 },
		});
		expect(
			await editWorkspace(workspace, {
				operations: [{ type: "create_file", path: "a.txt", content: "", base_version: "sha256:x" }],
			}),
		).toMatchObject({ status: "failed", error: { code: "INVALID_OPERATION", operation_index: 0 } });
	});

	it("create_file 成功且目标存在时报错", async () => {
		const created = await editWorkspace(workspace, {
			operations: [{ type: "create_file", path: "new.txt", content: "hello\n" }],
		});
		expect(created).toMatchObject({
			status: "applied",
			results: [{ index: 0, type: "create_file", path: "new.txt", old_version: null }],
		});
		expect(await readFile(path.join(workspace, "new.txt"), "utf8")).toBe("hello\n");
		expect(await editWorkspace(workspace, { operations: [{ type: "create_file", path: "new.txt", content: "" }] })).toMatchObject({
			status: "failed",
			error: { code: "FILE_ALREADY_EXISTS", operation_index: 0 },
		});
	});

	it("update_file 单 hunk 和多 hunk 成功", async () => {
		await writeFile(path.join(workspace, "a.txt"), "one\ntwo\nthree\nfour\n");
		const first = await readWorkspaceFile(workspace, { path: "a.txt" });
		if (!("version" in first)) throw new Error("read failed");
		const result = await editWorkspace(workspace, {
			operations: [
				{
					type: "update_file",
					path: "a.txt",
					base_version: first.version,
					diff: "@@\n one\n-two\n+TWO\n@@\n three\n-four\n+FOUR",
				},
			],
		});
		expect(result).toMatchObject({ status: "applied", results: [{ index: 0, type: "update_file", path: "a.txt" }] });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("one\nTWO\nthree\nFOUR\n");
	});

	it("update_file diff 解析失败、上下文不存在、不唯一和重叠", async () => {
		await writeFile(path.join(workspace, "a.txt"), "x\nsame\nsame\nz\n");
		const read = await readWorkspaceFile(workspace, { path: "a.txt" });
		if (!("version" in read)) throw new Error("read failed");
		const base = { type: "update_file" as const, path: "a.txt", base_version: read.version };
		expect(await editWorkspace(workspace, { operations: [{ ...base, diff: " x\n-y\n+z" }] })).toMatchObject({
			status: "failed",
			error: { code: "DIFF_PARSE_ERROR", operation_index: 0 },
		});
		expect(await editWorkspace(workspace, { operations: [{ ...base, diff: "@@\n-missing\n+new" }] })).toMatchObject({
			status: "failed",
			error: { code: "DIFF_CONTEXT_NOT_FOUND", operation_index: 0 },
		});
		expect(await editWorkspace(workspace, { operations: [{ ...base, diff: "@@\n same\n+new" }] })).toMatchObject({
			status: "failed",
			error: { code: "DIFF_CONTEXT_AMBIGUOUS", operation_index: 0 },
		});
		expect(await editWorkspace(workspace, { operations: [{ ...base, diff: "@@\n x\n same\n@@\n same\n-same\n+SAME" }] })).toMatchObject({
			status: "failed",
			error: { code: "DIFF_OVERLAPPING_HUNKS", operation_index: 0 },
		});
	});

	it("replace_file、delete_file、move_file 校验版本并成功执行", async () => {
		await writeFile(path.join(workspace, "replace.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("old\n")]));
		await writeFile(path.join(workspace, "delete.txt"), "bye\n");
		await writeFile(path.join(workspace, "move.txt"), "move\n");
		const replaceRead = await readWorkspaceFile(workspace, { path: "replace.txt" });
		const deleteRead = await readWorkspaceFile(workspace, { path: "delete.txt" });
		const moveRead = await readWorkspaceFile(workspace, { path: "move.txt" });
		if (!("version" in replaceRead) || !("version" in deleteRead) || !("version" in moveRead)) throw new Error("read failed");
		const result = await editWorkspace(
			workspace,
			{
				operations: [
					{ type: "replace_file", path: "replace.txt", base_version: replaceRead.version, content: "new" },
					{ type: "delete_file", path: "delete.txt", base_version: deleteRead.version },
					{ type: "move_file", from: "move.txt", to: "moved.txt", base_version: moveRead.version },
				],
			},
			standardPermission(),
		);
		expect(result).toMatchObject({
			status: "applied",
			results: [
				{ index: 0, type: "replace_file", path: "replace.txt" },
				{ index: 1, type: "delete_file", path: "delete.txt", new_version: null },
				{ index: 2, type: "move_file", from: "move.txt", to: "moved.txt" },
			],
		});
		expect(await readFile(path.join(workspace, "replace.txt"))).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("new")]));
		await expect(readFile(path.join(workspace, "delete.txt"))).rejects.toThrow();
		expect(await readFile(path.join(workspace, "moved.txt"), "utf8")).toBe("move\n");
	});

	it("版本冲突不会覆盖外部修改", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old\n");
		const read = await readWorkspaceFile(workspace, { path: "a.txt" });
		if (!("version" in read)) throw new Error("read failed");
		await writeFile(path.join(workspace, "a.txt"), "external\n");
		const result = await editWorkspace(workspace, {
			operations: [{ type: "replace_file", path: "a.txt", base_version: read.version, content: "new\n" }],
		});
		expect(result).toMatchObject({ status: "failed", error: { code: "STALE_BASE_VERSION", operation_index: 0 } });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("external\n");
	});

	it("多文件事务成功，失败时零文件被修改，提交失败后回滚", async () => {
		await writeFile(path.join(workspace, "a.txt"), "a\n");
		await writeFile(path.join(workspace, "b.txt"), "b\n");
		const a = await readWorkspaceFile(workspace, { path: "a.txt" });
		const b = await readWorkspaceFile(workspace, { path: "b.txt" });
		if (!("version" in a) || !("version" in b)) throw new Error("read failed");
		expect(
			await editWorkspace(workspace, {
				operations: [
					{ type: "replace_file", path: "a.txt", base_version: a.version, content: "aa\n" },
					{ type: "replace_file", path: "b.txt", base_version: b.version, content: "bb\n" },
				],
			}),
		).toMatchObject({ status: "applied" });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("aa\n");
		expect(await readFile(path.join(workspace, "b.txt"), "utf8")).toBe("bb\n");

		const a2 = await readWorkspaceFile(workspace, { path: "a.txt" });
		const b2 = await readWorkspaceFile(workspace, { path: "b.txt" });
		if (!("version" in a2) || !("version" in b2)) throw new Error("read failed");
		expect(
			await editWorkspace(workspace, {
				operations: [
					{ type: "replace_file", path: "a.txt", base_version: a2.version, content: "aaa\n" },
					{ type: "replace_file", path: "b.txt", base_version: "sha256:stale", content: "bbb\n" },
				],
			}),
		).toMatchObject({ status: "failed", error: { code: "STALE_BASE_VERSION", operation_index: 1 } });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("aa\n");
		expect(await readFile(path.join(workspace, "b.txt"), "utf8")).toBe("bb\n");

		let writes = 0;
		const rollbackResult = await editWorkspace(
			workspace,
			{
				operations: [
					{ type: "replace_file", path: "a.txt", base_version: a2.version, content: "rollback-a\n" },
					{ type: "replace_file", path: "b.txt", base_version: b2.version, content: "rollback-b\n" },
				],
			},
			{
				writeFileAtomic: async (target, bytes) => {
					writes += 1;
					if (writes === 2) throw new Error("injected");
					await writeFile(target, bytes);
				},
			},
		);
		expect(rollbackResult).toMatchObject({ status: "failed", error: { code: "TRANSACTION_COMMIT_FAILED" } });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("aa\n");
		expect(await readFile(path.join(workspace, "b.txt"), "utf8")).toBe("bb\n");
	});

	it("检测冲突 operation，并保留 LF、CRLF、无尾部换行", async () => {
		await writeFile(path.join(workspace, "lf.txt"), "a\nb\n");
		await writeFile(path.join(workspace, "crlf.txt"), "a\r\nb\r\n");
		await writeFile(path.join(workspace, "nonewline.txt"), "a\nb");
		const lf = await readWorkspaceFile(workspace, { path: "lf.txt" });
		const crlf = await readWorkspaceFile(workspace, { path: "crlf.txt" });
		const nonewline = await readWorkspaceFile(workspace, { path: "nonewline.txt" });
		if (!("version" in lf) || !("version" in crlf) || !("version" in nonewline)) throw new Error("read failed");
		expect(
			await editWorkspace(workspace, {
				operations: [
					{ type: "replace_file", path: "lf.txt", base_version: lf.version, content: "x\n" },
					{ type: "delete_file", path: "LF.txt", base_version: lf.version },
				],
			}),
		).toMatchObject({ status: "failed", error: { code: "CONFLICTING_OPERATIONS", operation_index: 1 } });
		await editWorkspace(workspace, {
			operations: [
				{ type: "update_file", path: "lf.txt", base_version: lf.version, diff: "@@\n-a\n+A" },
				{ type: "update_file", path: "crlf.txt", base_version: crlf.version, diff: "@@\n-a\n+A" },
				{ type: "update_file", path: "nonewline.txt", base_version: nonewline.version, diff: "@@\n-b\n+B" },
			],
		});
		expect(await readFile(path.join(workspace, "lf.txt"), "utf8")).toBe("A\nb\n");
		expect(await readFile(path.join(workspace, "crlf.txt"), "utf8")).toBe("A\r\nb\r\n");
		expect(await readFile(path.join(workspace, "nonewline.txt"), "utf8")).toBe("a\nB");
	});

	it("端到端 read -> edit -> read 返回新内容和新版本", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old\n");
		const before = await readWorkspaceFile(workspace, { path: "a.txt" });
		if (!("version" in before)) throw new Error("read failed");
		const edit = await editWorkspace(workspace, {
			operations: [{ type: "update_file", path: "a.txt", base_version: before.version, diff: "@@\n-old\n+new" }],
		});
		expect(edit).toMatchObject({ status: "applied", results: [{ index: 0, type: "update_file" }] });
		const after = await readWorkspaceFile(workspace, { path: "a.txt" });
		expect(after).toMatchObject({ content: "new\n" });
		if ("version" in after) expect(after.version).not.toBe(before.version);
	});
});

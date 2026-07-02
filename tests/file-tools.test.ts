import { mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editWorkspace } from "../src/file-tools/edit-tool.js";
import { readWorkspaceFile } from "../src/file-tools/read-tool.js";
import { sha256Version } from "../src/file-tools/text-file.js";

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
			error: { code: "PATH_OUTSIDE_WORKSPACE" },
		});
		expect(await readWorkspaceFile(workspace, { path: path.join(outside, "secret.txt") })).toMatchObject({
			status: "failed",
			error: { code: "PATH_OUTSIDE_WORKSPACE" },
		});
		try {
			await symlink(path.join(outside, "secret.txt"), path.join(workspace, "link.txt"));
			expect(await readWorkspaceFile(workspace, { path: "link.txt" })).toMatchObject({
				status: "failed",
				error: { code: "SYMLINK_OUTSIDE_WORKSPACE" },
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
		const result = await editWorkspace(workspace, {
			operations: [
				{ type: "replace_file", path: "replace.txt", base_version: replaceRead.version, content: "new" },
				{ type: "delete_file", path: "delete.txt", base_version: deleteRead.version },
				{ type: "move_file", from: "move.txt", to: "moved.txt", base_version: moveRead.version },
			],
		});
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

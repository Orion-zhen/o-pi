import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { piTextDiffGenerator } from "../../src/file-tools/pi/ports/text-diff.js";
import { contentHash as sha256Version } from "../../src/filesystem/services/text.js";
import { createCrudTestContext } from "./crud-fixtures.js";
import { expectFailure } from "./result-fixtures.js";

const testContext = createCrudTestContext();
let workspace: string;
let outside: string;

beforeEach(() => {
	workspace = testContext.workspace;
	outside = testContext.outside;
});

describe("write", () => {
	it("拒绝空路径", async () => {
		expectFailure(await testContext.write({ path: "", content: "x" }), "INVALID_PATH");
	});

	it("拒绝超过 write 单文件上限的输入和已有 snapshot，且不修改目标", async () => {
		await testContext.useConfig({ limits: { write_max_file_bytes: 1024 } });
		const existing = path.join(workspace, "existing-large.txt");
		const original = "x".repeat(1025);
		await writeFile(existing, original);

		expectFailure(await testContext.write({ path: "new-large.txt", content: "y".repeat(1025) }), {
			code: "OUTPUT_LIMIT_EXCEEDED", details: { limit: 1024, size: 1025 },
		});
		await expect(readFile(path.join(workspace, "new-large.txt"))).rejects.toMatchObject({ code: "ENOENT" });

		expectFailure(await testContext.write({ path: "existing-large.txt", content: "small" }), {
			code: "OUTPUT_LIMIT_EXCEEDED", details: { limit: 1024, size: 1025 },
		});
		expect(await readFile(existing, "utf8")).toBe(original);

		expect(await testContext.write({ path: "exact-limit.txt", content: "z".repeat(1024) })).toMatchObject({
			status: "written",
			after_size_bytes: 1024,
		});
		expect(await readFile(path.join(workspace, "exact-limit.txt"), "utf8")).toBe("z".repeat(1024));
	});

	it("创建缺失父目录并写入 UTF-8 内容", async () => {
		const content = "hello\n你好\n";
		const bytes = Buffer.from(content, "utf8");
		const result = await testContext.write({ path: "new/dir/file.txt", content });
		expect(result).toMatchObject({
			status: "written",
			path: "new/dir/file.txt",
			bytes: bytes.byteLength,
			action: "create",
			after_version: sha256Version(bytes),
			after_size_bytes: bytes.byteLength,
			diff: expect.stringContaining("+1 hello"),
		});
		expect(result).not.toHaveProperty("before_version");
		expect(result).not.toHaveProperty("before_size_bytes");
		expect(await readFile(path.join(workspace, "new", "dir", "file.txt"), "utf8")).toBe("hello\n你好\n");
	});

	it("写入后允许直接 edit，并继续检测外部修改", async () => {
		await testContext.write({ path: "a.txt", content: "old\n" });
		expect(await testContext.edit({ path: "a.txt", edits: [{ old: "old", new: "new" }] })).toMatchObject({
			status: "applied",
			path: "a.txt",
		});

		await testContext.write({ path: "a.txt", content: "old\n" });
		await writeFile(path.join(workspace, "a.txt"), "external\n");
		expectFailure(await testContext.edit({ path: "a.txt", edits: [{ old: "old", new: "new" }] }), { code: "STALE_READ", path: "a.txt" });
	});

	it("覆盖已有文件，不要求先 read", async () => {
		const before = Buffer.from("old\n");
		const after = Buffer.from("new\n");
		await writeFile(path.join(workspace, "a.txt"), before);
		const result = await testContext.write({ path: "a.txt", content: after.toString("utf8") });
		expect(result).toMatchObject({
			status: "written",
			path: "a.txt",
			action: "modify",
			before_version: sha256Version(before),
			after_version: sha256Version(after),
			before_size_bytes: before.byteLength,
			after_size_bytes: after.byteLength,
			diff: expect.stringContaining("-1 old"),
		});
		expect(result).toMatchObject({ diff: expect.stringContaining("+1 new") });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("new\n");
	});

	it("允许写入 cwd 外的绝对路径", async () => {
		const externalFile = path.join(outside, "nested", "external.txt");
		const result = await testContext.write({ path: externalFile, content: "external\n" });
		expect(result).toMatchObject({ status: "written", path: path.normalize(externalFile) });
		expect(await readFile(externalFile, "utf8")).toBe("external\n");
	});

	it("workspace 内绝对写入路径返回 workspace-relative path", async () => {
		const result = await testContext.write({ path: path.join(workspace, "nested", "inside.txt"), content: "inside\n" });
		expect(result).toMatchObject({ status: "written", path: "nested/inside.txt" });
		expect(await readFile(path.join(workspace, "nested", "inside.txt"), "utf8")).toBe("inside\n");
	});

	it("拒绝写入 blocked path", async () => {
		await mkdir(path.join(workspace, ".git"));
		expectFailure(await testContext.write({ path: ".git/config", content: "[core]\n" }), { code: "PROTECTED_PATH", path: ".git/config" });
	});

	it.skipIf(process.platform === "win32")("提交 mutation 前重新检查排队期间变成 blocked target 的 symlink", async () => {
		const target = path.join(workspace, "queued.txt");
		const protectedDir = path.join(outside, "protected-queue");
		const protectedFile = path.join(protectedDir, "secret.txt");
		await mkdir(protectedDir);
		await writeFile(target, "original\n");
		await writeFile(protectedFile, "secret\n");
		await testContext.useConfig({ blocked_path: [`${protectedDir}/`] });

		let releaseQueue: (() => void) | undefined;
		let markQueueEntered: (() => void) | undefined;
		const queueEntered = new Promise<void>((resolve) => { markQueueEntered = resolve; });
		const queueRelease = new Promise<void>((resolve) => { releaseQueue = resolve; });
		const pendingWrite = testContext.write({ path: "queued.txt", content: "unsafe\n" }, {
			async generate(before, after) {
				markQueueEntered?.();
				await queueRelease;
				return await piTextDiffGenerator.generate(before, after);
			},
		});
		await queueEntered;

		await rm(target);
		await symlink(protectedFile, target);
		releaseQueue?.();

		await expect(pendingWrite).resolves.toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH", path: "queued.txt" },
		});
		expect(await readFile(protectedFile, "utf8")).toBe("secret\n");
	});

});

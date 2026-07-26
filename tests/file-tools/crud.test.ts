import { mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editFile, previewEdit } from "../../src/file-tools/edit/command.js";
import type { EditDiagnosticsSource } from "../../src/file-tools/edit/ports.js";
import type { EditSuccess } from "../../src/file-tools/edit/types.js";
import { FileToolsHost, type FileToolsInvocation } from "../../src/file-tools/runtime/host.js";
import { isPlainRecord } from "../../src/file-tools/pi/guards.js";
import { piTextDiffGenerator } from "../../src/file-tools/pi/ports/text-diff.js";
import { contentHash as sha256Version } from "../../src/filesystem/services/text.js";
import type { ToolOutcome } from "../../src/file-tools/shared/result.js";
import type { TextDiffGenerator } from "../../src/file-tools/shared/text-diff.js";
import { writeFile as writeFileCommand } from "../../src/file-tools/write/command.js";
import type { WriteSuccess } from "../../src/file-tools/write/types.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";
import { readWorkspaceFile as readWorkspaceFileTest, type ReadWorkspaceTestOptions } from "../helpers/read-tool.js";

let workspace: string;
let outside: string;
let host: FileToolsHost;
const workspaceTemp = useTempDir("o-pi-workspace-");
const outsideTemp = useTempDir("o-pi-outside-");
preserveEnv("PI_FILE_TOOLS_CONFIG");

beforeEach(() => {
	workspace = workspaceTemp.path;
	outside = outsideTemp.path;
	host = new FileToolsHost();
});

afterEach(() => host.dispose());

function readWorkspaceFile(cwd: string, params: Parameters<typeof readWorkspaceFileTest>[1], options: ReadWorkspaceTestOptions = {}) {
	return readWorkspaceFileTest(cwd, params, { ...options, host, sessionId: "crud" });
}

async function editWorkspace(
	cwd: string,
	params: unknown,
	runtime: { signal?: AbortSignal; diagnostics?: EditDiagnosticsSource } = {},
): Promise<ToolOutcome<EditSuccess>> {
	const opened = await openInvocation(cwd, runtime.signal);
	if ("status" in opened) return opened;
	try {
		return await editFile(params, {
			filesystem: opened.filesystem,
			operation: opened.context,
			observation: opened.observation,
			matchHintLimit: opened.limits.edit_match_hint_limit,
			diff: piTextDiffGenerator,
			...(runtime.diagnostics === undefined ? {} : { diagnostics: runtime.diagnostics }),
		});
	} finally {
		opened.dispose();
	}
}

async function writeWorkspaceFile(
	cwd: string,
	params: unknown,
	diff: TextDiffGenerator = piTextDiffGenerator,
): Promise<ToolOutcome<WriteSuccess>> {
	const opened = await openInvocation(cwd);
	if ("status" in opened) return opened;
	try {
		return await writeFileCommand(params, { filesystem: opened.filesystem, operation: opened.context, diff });
	} finally {
		opened.dispose();
	}
}

function openInvocation(cwd: string, signal?: AbortSignal): Promise<ToolOutcome<FileToolsInvocation>> {
	return host.open({ cwd, sessionId: "crud", ...(signal === undefined ? {} : { signal }) });
}

async function useFileToolsConfig(config: Record<string, unknown>): Promise<void> {
	const configPath = path.join(outside, `file-tools-${Date.now()}-${Math.random()}.jsonc`);
	await writeFile(configPath, JSON.stringify(config, null, 2));
	process.env.PI_FILE_TOOLS_CONFIG = configPath;
}

describe("read", () => {
	it("文件不存在时为 workspace 内路径附加相似路径建议", async () => {
		await mkdir(path.join(workspace, "src"), { recursive: true });
		await writeFile(path.join(workspace, "src", "main.ts"), "export const main = 1;\n");

		const result = await readWorkspaceFile(workspace, { path: "src/maim.ts" });
		expect(result).toMatchObject({
			status: "failed",
			error: {
				code: "FILE_NOT_FOUND",
				next: expect.stringContaining("Related paths: src/main.ts"),
			},
		});
	});

	it("workspace 外路径不存在时不附加路径建议", async () => {
		const result = await readWorkspaceFile(workspace, { path: path.join(outside, "main.ts") });
		expect(result).toMatchObject({ status: "failed", error: { code: "FILE_NOT_FOUND" } });
		if ("status" in result) expect(result.error.next).toBeUndefined();
	});

	it("空 workspace 没有相似文件时保持原始 FILE_NOT_FOUND 错误", async () => {
		const result = await readWorkspaceFile(workspace, { path: "missing-completely.ts" });
		expect(result).toMatchObject({ status: "failed", error: { code: "FILE_NOT_FOUND" } });
		if ("status" in result) expect(result.error.next).toBeUndefined();
	});

	it("配置 read_suggestion_limit 控制建议数量", async () => {
		await writeFile(path.join(workspace, "main.ts"), "");
		await writeFile(path.join(workspace, "main.test.ts"), "");
		await useFileToolsConfig({ limits: { read_suggestion_limit: 1 } });

		const result = await readWorkspaceFile(workspace, { path: "main.mts" });
		expect(result).toMatchObject({ status: "failed", error: { code: "FILE_NOT_FOUND" } });
		if ("status" in result) {
			expect(result.error.next).toMatch(/^Related paths: [^,]+$/u);
		}
	});

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

	it("读取图片文件并返回模型可内联图片数据", async () => {
		const imageBytes = Buffer.from("R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64");
		await writeFile(path.join(workspace, "pixel.gif"), imageBytes);
		const result = await readWorkspaceFile(workspace, { path: "pixel.gif" });
		expect(result).toMatchObject({
			path: "pixel.gif",
			media_type: "image",
			mime_type: "image/gif",
			content: "Read image file [image/gif]",
			size_bytes: imageBytes.byteLength,
			image: {
				data: imageBytes.toString("base64"),
				mime_type: "image/gif",
			},
		});
		if ("version" in result) expect(result.version).toBe(sha256Version(imageBytes));
		expect(await readWorkspaceFile(workspace, { path: "pixel.gif", start_line: 1 })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_OPERATION" },
		});
	});

	it("按行范围读取且不把行号写进 content", async () => {
		await writeFile(path.join(workspace, "a.txt"), "one\ntwo\nthree\n", "utf8");
		const result = await readWorkspaceFile(workspace, { path: "a.txt", start_line: 2, end_line: 2 });
		expect(result).toMatchObject({ content: "two\n", start_line: 2, end_line: 2, total_lines: 3 });
	});

	it("end_line 超过文件末尾时读取到文件末尾", async () => {
		await writeFile(path.join(workspace, "a.txt"), "one\ntwo\nthree\n", "utf8");
		const result = await readWorkspaceFile(workspace, { path: "a.txt", start_line: 2, end_line: 99 });
		expect(result).toMatchObject({
			content: "two\nthree\n",
			start_line: 2,
			end_line: 3,
			total_lines: 3,
			truncated: false,
		});
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
		await useFileToolsConfig({ limits: { read_lines: 2 } });
		await writeFile(path.join(workspace, "big.txt"), "one\ntwo\nthree\n");
		const result = await readWorkspaceFile(workspace, { path: "big.txt" });
		expect(result).toMatchObject({ truncated: true, continuation: { start_line: 3 }, end_line: 2 });
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

	it("允许读取绝对路径、.. 相对路径和指向外部的符号链接", async () => {
		const secret = path.join(outside, "secret.txt");
		await writeFile(secret, "secret");
		await writeFile(path.join(workspace, "inside.txt"), "inside");
		const relativeOutside = path.relative(workspace, secret);
		expect(await readWorkspaceFile(workspace, { path: path.join(workspace, "inside.txt") })).toMatchObject({
			path: "inside.txt",
			content: "inside",
		});
		expect(await readWorkspaceFile(workspace, { path: relativeOutside })).toMatchObject({
			path: relativeOutside.replace(/\\/g, "/"),
			content: "secret",
		});
		expect(await readWorkspaceFile(workspace, { path: secret })).toMatchObject({
			path: path.normalize(secret),
			content: "secret",
		});
		try {
			await symlink(secret, path.join(workspace, "link.txt"));
			expect(await readWorkspaceFile(workspace, { path: "link.txt" })).toMatchObject({
				path: "link.txt",
				content: "secret",
			});
		} catch {
			// Windows 未启用符号链接权限时跳过该断言。
		}
	});

	it("blocked_path 对 lexical path 和 realpath 都生效", async () => {
		const protectedDir = path.join(outside, "protected");
		await mkdir(protectedDir);
		await writeFile(path.join(workspace, "blocked.txt"), "blocked\n");
		await writeFile(path.join(protectedDir, "secret.txt"), "secret\n");
		await useFileToolsConfig({ blocked_path: ["blocked.txt", `${protectedDir}/`] });

		expect(await readWorkspaceFile(workspace, { path: "blocked.txt" })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH", path: "blocked.txt" },
		});

		try {
			await symlink(path.join(protectedDir, "secret.txt"), path.join(workspace, "secret-link.txt"));
		} catch {
			return;
		}
		expect(await readWorkspaceFile(workspace, { path: "secret-link.txt" })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH", path: "secret-link.txt" },
		});
	});

	it("拒绝读取 .git", async () => {
		await mkdir(path.join(workspace, ".git"));
		await writeFile(path.join(workspace, ".git", "config"), "[core]\n");
		expect(await readWorkspaceFile(workspace, { path: ".git/config" })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH", path: ".git/config" },
		});
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

describe("write", () => {
	it("拒绝非法 schema 和空路径", async () => {
		expect(await writeWorkspaceFile(workspace, "x")).toMatchObject({
			status: "failed",
			error: { code: "INVALID_OPERATION" },
		});
		expect(await writeWorkspaceFile(workspace, { path: "", content: "x" })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_PATH" },
		});
		expect(await writeWorkspaceFile(workspace, { path: "a.txt", content: 1 })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_OPERATION" },
		});
		expect(await writeWorkspaceFile(workspace, { path: "a.txt", content: "", extra: true })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_OPERATION" },
		});
	});

	it("创建缺失父目录并写入 UTF-8 内容", async () => {
		const content = "hello\n你好\n";
		const bytes = Buffer.from(content, "utf8");
		const result = await writeWorkspaceFile(workspace, { path: "new/dir/file.txt", content });
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
		await writeWorkspaceFile(workspace, { path: "a.txt", content: "old\n" });
		expect(await editWorkspace(workspace, { path: "a.txt", edits: [{ old: "old", new: "new" }] })).toMatchObject({
			status: "applied",
			path: "a.txt",
		});

		await writeWorkspaceFile(workspace, { path: "a.txt", content: "old\n" });
		await writeFile(path.join(workspace, "a.txt"), "external\n");
		expect(await editWorkspace(workspace, { path: "a.txt", edits: [{ old: "old", new: "new" }] })).toMatchObject({
			status: "failed",
			error: { code: "STALE_READ", path: "a.txt" },
		});
	});

	it("覆盖已有文件，不要求先 read", async () => {
		const before = Buffer.from("old\n");
		const after = Buffer.from("new\n");
		await writeFile(path.join(workspace, "a.txt"), before);
		const result = await writeWorkspaceFile(workspace, { path: "a.txt", content: after.toString("utf8") });
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
		const result = await writeWorkspaceFile(workspace, { path: externalFile, content: "external\n" });
		expect(result).toMatchObject({ status: "written", path: path.normalize(externalFile) });
		expect(await readFile(externalFile, "utf8")).toBe("external\n");
	});

	it("workspace 内绝对写入路径返回 workspace-relative path", async () => {
		const result = await writeWorkspaceFile(workspace, { path: path.join(workspace, "nested", "inside.txt"), content: "inside\n" });
		expect(result).toMatchObject({ status: "written", path: "nested/inside.txt" });
		expect(await readFile(path.join(workspace, "nested", "inside.txt"), "utf8")).toBe("inside\n");
	});

	it("拒绝写入 blocked path", async () => {
		await mkdir(path.join(workspace, ".git"));
		expect(await writeWorkspaceFile(workspace, { path: ".git/config", content: "[core]\n" })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH", path: ".git/config" },
		});
	});

	it.skipIf(process.platform === "win32")("提交 mutation 前重新检查排队期间变成 blocked target 的 symlink", async () => {
		const target = path.join(workspace, "queued.txt");
		const protectedDir = path.join(outside, "protected-queue");
		const protectedFile = path.join(protectedDir, "secret.txt");
		await mkdir(protectedDir);
		await writeFile(target, "original\n");
		await writeFile(protectedFile, "secret\n");
		await useFileToolsConfig({ blocked_path: [`${protectedDir}/`] });

		let releaseQueue: (() => void) | undefined;
		let markQueueEntered: (() => void) | undefined;
		const queueEntered = new Promise<void>((resolve) => { markQueueEntered = resolve; });
		const queueRelease = new Promise<void>((resolve) => { releaseQueue = resolve; });
		const pendingWrite = writeWorkspaceFile(workspace, { path: "queued.txt", content: "unsafe\n" }, {
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

	it("拒绝通过 target symlink 或 parent symlink 写入 blocked_path", async () => {
		const protectedDir = path.join(outside, "protected");
		await mkdir(protectedDir);
		await writeFile(path.join(protectedDir, "target.txt"), "secret\n");
		await useFileToolsConfig({ blocked_path: [`${protectedDir}/`] });
		try {
			await symlink(path.join(protectedDir, "target.txt"), path.join(workspace, "target-link.txt"));
			await symlink(protectedDir, path.join(workspace, "parent-link"), "dir");
		} catch {
			return;
		}

		expect(await writeWorkspaceFile(workspace, { path: "target-link.txt", content: "new\n" })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH", path: "target-link.txt" },
		});
		expect(await writeWorkspaceFile(workspace, { path: "parent-link/new.txt", content: "new\n" })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH", path: "parent-link/new.txt" },
		});
		expect(await readFile(path.join(protectedDir, "target.txt"), "utf8")).toBe("secret\n");
	});
});

describe("edit", () => {
	it("拒绝旧 operations/patch 协议和非法 exact replacement schema", async () => {
		expect(await editWorkspace(workspace, { operations: [] })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_OPERATION" },
		});
		expect(await editWorkspace(workspace, { path: "a.txt", edits: [] })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_OPERATION" },
		});
		expect(await editWorkspace(workspace, { path: "a.txt", edits: [{ old: "", new: "x" }] })).toMatchObject({
			status: "failed",
			error: { code: "EMPTY_OLD_TEXT", edit_index: 0 },
		});
		expect(await editWorkspace(workspace, { path: "a.txt", edits: [{ old: "x", new: "y", extra: true }] })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_OPERATION", edit_index: 0 },
		});
	});

	it("要求目标文件存在且必须先 read", async () => {
		expect(await editWorkspace(workspace, { path: "missing.txt", edits: [{ old: "old", new: "new" }] })).toMatchObject({
			status: "failed",
			error: { code: "FILE_NOT_FOUND" },
		});
		await writeFile(path.join(workspace, "a.txt"), "old\n");
		expect(await editWorkspace(workspace, { path: "a.txt", edits: [{ old: "old", new: "new" }] })).toMatchObject({
			status: "failed",
			error: { code: "READ_REQUIRED", path: "a.txt", next: "Read the file, then create a new edit operation." },
		});
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("old\n");
	});

	it("一次调用可对同一文件做多个非重叠替换", async () => {
		await writeFile(path.join(workspace, "a.txt"), "one\ntwo\nthree\nfour\n");
		const before = await readWorkspaceFile(workspace, { path: "a.txt" });
		if (!("version" in before)) throw new Error("read failed");

		const result = await editWorkspace(workspace, {
			path: "a.txt",
			edits: [
				{ old: "two", new: "TWO" },
				{ old: "four", new: "FOUR" },
			],
		});

		expect(result).toMatchObject({
			status: "applied",
			path: "a.txt",
			replacements: 2,
			old_version: before.version,
			old_size_bytes: Buffer.byteLength("one\ntwo\nthree\nfour\n"),
			new_size_bytes: Buffer.byteLength("one\nTWO\nthree\nFOUR\n"),
		});
		if (!("error" in result)) expect(result.new_version).toBe(sha256Version(Buffer.from("one\nTWO\nthree\nFOUR\n")));
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("one\nTWO\nthree\nFOUR\n");
		if (!("error" in result)) {
			expect(result.diff).toContain("-2 two");
			expect(result.diff).toContain("+2 TWO");
			expect(result.firstChangedLine).toBe(2);
		}
	});

	it("并发 edit 同一文件时串行读取和写入，不丢失修改", async () => {
		await writeFile(path.join(workspace, "a.txt"), "alpha beta\n");
		const before = await readWorkspaceFile(workspace, { path: "a.txt" });
		if (!("version" in before)) throw new Error("read failed");

		const [alpha, beta] = await Promise.all([
			editWorkspace(workspace, { path: "a.txt", edits: [{ old: "alpha", new: "ALPHA" }] }),
			editWorkspace(workspace, { path: "a.txt", edits: [{ old: "beta", new: "BETA" }] }),
		]);

		expect(alpha).toMatchObject({ status: "applied", path: "a.txt" });
		expect(beta).toMatchObject({ status: "applied", path: "a.txt" });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("ALPHA BETA\n");
	});

	it("所有 old 都针对原始文件匹配，而不是按前序替换后的内容匹配", async () => {
		await writeFile(path.join(workspace, "a.txt"), "a b c\n");
		const before = await readWorkspaceFile(workspace, { path: "a.txt" });
		if (!("version" in before)) throw new Error("read failed");

		expect(
			await editWorkspace(workspace, {
				path: "a.txt",
				edits: [
					{ old: "a", new: "x" },
					{ old: "x", new: "y" },
				],
			}),
		).toMatchObject({ status: "failed", error: { code: "OLD_TEXT_NOT_FOUND", edit_index: 1 } });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("a b c\n");
	});

	it("重复 old 返回总数、最短唯一 old/new 和起始行号", async () => {
		await writeFile(path.join(workspace, "a.txt"), "const mode = \"dev\";\nconst mode = \"prod\";\nconst mode = \"test\";\n");
		await readWorkspaceFile(workspace, { path: "a.txt" });

		const result = await editWorkspace(workspace, { path: "a.txt", edits: [{ old: "const mode =", new: "let mode =" }] });
		expect(result).toMatchObject({
			status: "failed",
			error: {
				code: "OLD_TEXT_NOT_UNIQUE",
				message: "edits[0].old matched 3 locations.",
				next: "Retry with one shown old/new pair; read only if the file changed.",
				details: { matches: 3, shown: 3, hints: [
					{ line: 1, old: expect.stringContaining("d"), new: expect.stringContaining("let mode") },
					{ line: 2, old: expect.stringContaining("p"), new: expect.stringContaining("let mode") },
					{ line: 3, old: expect.stringContaining("t"), new: expect.stringContaining("let mode") },
				] },
			},
		});
		if (!("error" in result)) throw new Error("edit unexpectedly succeeded");
		const hints = result.error.details?.["hints"];
		if (!Array.isArray(hints) || hints.length === 0) throw new Error("edit hints missing");
		const first = hints[0];
		if (!isPlainRecord(first) || typeof first["old"] !== "string" || typeof first["new"] !== "string") throw new Error("invalid edit hint");
		const retry = await editWorkspace(workspace, { path: "a.txt", edits: [{ old: first["old"], new: first["new"] }] });
		expect(retry).toMatchObject({ status: "applied", replacements: 1 });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("let mode = \"dev\";\nconst mode = \"prod\";\nconst mode = \"test\";\n");
	});

	it("配置 edit hint 数量", async () => {
		await writeFile(path.join(workspace, "a.txt"), "same\nsame\nsame\n");
		await readWorkspaceFile(workspace, { path: "a.txt" });
		await useFileToolsConfig({ limits: { edit_match_hint_limit: 2 } });

		const result = await editWorkspace(workspace, { path: "a.txt", edits: [{ old: "same", new: "new" }] });
		expect(result).toMatchObject({ status: "failed", error: { code: "OLD_TEXT_NOT_UNIQUE", message: "edits[0].old matched 3 locations, 2 shown.", details: { matches: 3, shown: 2, hints: expect.any(Array) } } });
		if ("error" in result) expect(result.error.details?.["hints"]).toHaveLength(2);
	});

	it("拒绝不存在、不唯一和重叠的 old", async () => {
		await writeFile(path.join(workspace, "a.txt"), "abc same same xyz\n");
		const before = await readWorkspaceFile(workspace, { path: "a.txt" });
		if (!("version" in before)) throw new Error("read failed");

		expect(await editWorkspace(workspace, { path: "a.txt", edits: [{ old: "missing", new: "new" }] })).toMatchObject({
			status: "failed",
			error: { code: "OLD_TEXT_NOT_FOUND", edit_index: 0 },
		});
		expect(await editWorkspace(workspace, { path: "a.txt", edits: [{ old: "same", new: "new" }] })).toMatchObject({
			status: "failed",
			error: { code: "OLD_TEXT_NOT_UNIQUE", edit_index: 0 },
		});
		expect(
			await editWorkspace(workspace, {
				path: "a.txt",
				edits: [
					{ old: "abc", new: "ABC" },
					{ old: "bc same", new: "BC SAME" },
				],
			}),
		).toMatchObject({ status: "failed", error: { code: "OVERLAPPING_REPLACEMENTS", edit_index: 1 } });
	});

	it("AbortSignal 在提交前取消 edit 且不修改文件", async () => {
		const file = path.join(workspace, "a.txt");
		await writeFile(file, "old\n");
		await readWorkspaceFile(workspace, { path: "a.txt" });
		const controller = new AbortController();
		const result = await editWorkspace(workspace, { path: "a.txt", edits: [{ old: "old", new: "new" }] }, {
			signal: controller.signal,
			diagnostics: {
				async beforeEdit() {
					controller.abort();
					return undefined;
				},
				async afterEdit() { return undefined; },
			},
		});
		expect(result).toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
		expect(await readFile(file, "utf8")).toBe("old\n");
	});

	it("版本冲突不会覆盖外部修改", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old\n");
		const before = await readWorkspaceFile(workspace, { path: "a.txt" });
		if (!("version" in before)) throw new Error("read failed");
		await writeFile(path.join(workspace, "a.txt"), "external\n");
		const result = await editWorkspace(workspace, { path: "a.txt", edits: [{ old: "old", new: "new" }] });
		expect(result).toMatchObject({
			status: "failed",
			error: { code: "STALE_READ", path: "a.txt", next: "Read the file again, then create a new edit operation." },
		});
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("external\n");
	});

	it("保留 UTF-8 BOM、CRLF 和无尾部换行", async () => {
		await writeFile(path.join(workspace, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("old\n")]));
		await writeFile(path.join(workspace, "crlf.txt"), "a\r\nb\r\n");
		await writeFile(path.join(workspace, "nonewline.txt"), "a\nb");
		const bom = await readWorkspaceFile(workspace, { path: "bom.txt" });
		const crlf = await readWorkspaceFile(workspace, { path: "crlf.txt" });
		const nonewline = await readWorkspaceFile(workspace, { path: "nonewline.txt" });
		if (!("version" in bom) || !("version" in crlf) || !("version" in nonewline)) throw new Error("read failed");

		await editWorkspace(workspace, { path: "bom.txt", edits: [{ old: "old", new: "new" }] });
		await editWorkspace(workspace, { path: "crlf.txt", edits: [{ old: "a\r\n", new: "A\r\n" }] });
		await editWorkspace(workspace, { path: "nonewline.txt", edits: [{ old: "b", new: "B" }] });

		expect(await readFile(path.join(workspace, "bom.txt"))).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("new\n")]));
		expect(await readFile(path.join(workspace, "crlf.txt"), "utf8")).toBe("A\r\nb\r\n");
		expect(await readFile(path.join(workspace, "nonewline.txt"), "utf8")).toBe("a\nB");
	});

	it("允许修改 cwd 外的绝对路径并拒绝 blocked path", async () => {
		const externalFile = path.join(outside, "external.txt");
		await writeFile(externalFile, "hello\n");
		const read = await readWorkspaceFile(workspace, { path: externalFile });
		if (!("version" in read)) throw new Error("read failed");
		expect(await editWorkspace(workspace, { path: externalFile, edits: [{ old: "hello", new: "updated" }] })).toMatchObject({
			status: "applied",
			path: path.normalize(externalFile),
		});
		expect(await readFile(externalFile, "utf8")).toBe("updated\n");

		await mkdir(path.join(workspace, ".git"));
		await writeFile(path.join(workspace, ".git", "config"), "[core]\n");
		expect(await editWorkspace(workspace, { path: ".git/config", edits: [{ old: "[core]", new: "[x]" }] })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH", path: ".git/config" },
		});
	});

	it("edit 拒绝 realpath 命中 blocked_path 的 symlink", async () => {
		const protectedDir = path.join(outside, "protected");
		await mkdir(protectedDir);
		await writeFile(path.join(protectedDir, "secret.txt"), "secret\n");
		await useFileToolsConfig({ blocked_path: [`${protectedDir}/`] });
		try {
			await symlink(path.join(protectedDir, "secret.txt"), path.join(workspace, "secret-link.txt"));
		} catch {
			return;
		}
		expect(await editWorkspace(workspace, { path: "secret-link.txt", edits: [{ old: "secret", new: "new" }] })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH", path: "secret-link.txt" },
		});
	});

	it("端到端 read -> edit -> read 返回新内容和新版本", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old\n");
		const before = await readWorkspaceFile(workspace, { path: "a.txt" });
		if (!("version" in before)) throw new Error("read failed");
		const edit = await editWorkspace(workspace, { path: "a.txt", edits: [{ old: "old", new: "new" }] });
		expect(edit).toMatchObject({ status: "applied", path: "a.txt", replacements: 1 });
		const after = await readWorkspaceFile(workspace, { path: "a.txt" });
		expect(after).toMatchObject({ content: "new\n" });
		if ("version" in after) expect(after.version).not.toBe(before.version);
	});

	it("预览只读生成 diff，执行仍保持 read-before-edit 约束", async () => {
		await writeFile(path.join(workspace, "a.txt"), "old\n");
		const params = { path: "a.txt", edits: [{ old: "old", new: "new" }] };
		const opened = await openInvocation(workspace);
		if ("status" in opened) throw new Error(opened.error.message);
		const preview = await previewEdit(params, {
			filesystem: opened.filesystem,
			operation: opened.context,
			matchHintLimit: opened.limits.edit_match_hint_limit,
			diff: piTextDiffGenerator,
		});
		opened.dispose();
		if ("error" in preview) throw new Error(`preview failed: ${preview.error.code}`);
		expect(preview).toMatchObject({ status: "preview", path: "a.txt", replacements: 1, firstChangedLine: 1 });
		expect(preview.diff).toContain("-1 old");
		expect(preview.diff).toContain("+1 new");
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("old\n");

		const result = await editWorkspace(workspace, params);
		expect(result).toMatchObject({ status: "failed", error: { code: "READ_REQUIRED" } });
		expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("old\n");
	});
});

describe("read missing-path source", () => {
	it("优先使用外部可信建议并去重", async () => {
		const result = await readWorkspaceFile(workspace, { path: "missing.ts" }, {
			missingPaths: { async suggest() { return ["src/main.ts", "src/main.ts", "src/utils.ts"]; } },
		});
		expect(result).toMatchObject({
			status: "failed",
			error: { next: "Related paths: src/main.ts, src/utils.ts" },
		});
	});

	it("外部建议失败时降级到 filesystem catalog", async () => {
		await writeFile(path.join(workspace, "recovery.ts"), "");
		const result = await readWorkspaceFile(workspace, { path: "recover.ts" }, {
			missingPaths: { async suggest() { throw new Error("unavailable"); } },
		});
		expect(result).toMatchObject({
			status: "failed",
			error: { next: expect.stringContaining("recovery.ts") },
		});
	});
});

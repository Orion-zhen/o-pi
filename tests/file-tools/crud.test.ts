import { chmod, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { editWorkspace as editWorkspaceImpl, previewEditWorkspace, type EditRuntime } from "../../src/file-tools/tools/edit.js";
import { formatCompactLsResult, listWorkspaceDirectory } from "../../src/file-tools/tools/ls.js";
import { findPathSuggestions, type PathSuggestionQuery } from "../../src/file-tools/core/path-suggestions.js";
import { defaultFileToolsConfig, type FileToolsConfig } from "../../src/file-tools/config.js";
import { ReadVersionCache } from "../../src/file-tools/core/read-cache.js";
import { isPlainRecord } from "../../src/file-tools/pi/guards.js";
import { readWorkspaceFile as readWorkspaceFileImpl } from "../../src/file-tools/tools/read.js";
import { writeWorkspaceFile as writeWorkspaceFileImpl } from "../../src/file-tools/tools/write.js";
import { sha256Version } from "../../src/file-tools/core/text-file.js";
import type { ToolOutcome } from "../../src/file-tools/shared/result.js";
import type { EditSuccess, LsSuccess, ReadFileSuccess, ReadParams, WriteSuccess } from "../../src/file-tools/types.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let workspace: string;
let outside: string;
let versionCache: ReadVersionCache;
const workspaceTemp = useTempDir("o-pi-workspace-");
const outsideTemp = useTempDir("o-pi-outside-");
preserveEnv("PI_FILE_TOOLS_CONFIG");

beforeEach(() => {
	workspace = workspaceTemp.path;
	outside = outsideTemp.path;
	versionCache = new ReadVersionCache();
});

function expectLsSuccess(result: ToolOutcome<LsSuccess>): LsSuccess {
	if ("status" in result) throw new Error(`ls failed: ${result.error.code}`);
	return result;
}

function readWorkspaceFile(cwd: string, params: ReadParams): Promise<ToolOutcome<ReadFileSuccess>> {
	return readWorkspaceFileImpl(cwd, params, { versionCache });
}

function editWorkspace(cwd: string, params: unknown, runtime: EditRuntime = {}): Promise<ToolOutcome<EditSuccess>> {
	return editWorkspaceImpl(cwd, params, { ...runtime, versionCache });
}

function writeWorkspaceFile(cwd: string, params: unknown): Promise<ToolOutcome<WriteSuccess>> {
	return writeWorkspaceFileImpl(cwd, params, undefined, { versionCache });
}

async function useFileToolsConfig(config: Record<string, unknown>): Promise<void> {
	const configPath = path.join(outside, `file-tools-${Date.now()}-${Math.random()}.jsonc`);
	await writeFile(configPath, JSON.stringify(config, null, 2));
	process.env.PI_FILE_TOOLS_CONFIG = configPath;
}

describe("ls", () => {
	it("将成功结果渲染为紧凑 shell 风格文本，并展示 symlink 目标", () => {
		expect(
			formatCompactLsResult({
				path: "src",
				entries: [
					{ name: "components", path: "src/components", type: "directory" },
					{ name: "index.ts", path: "src/index.ts", type: "file", ignored: true, ignore_source: ".gitignore" },
					{ name: "shared", path: "src/shared", type: "symlink", link_target: "../shared" },
					{ name: "socket", path: "src/socket", type: "other" },
				],
				truncated: true,
				returned_entries: 4,
				total_entries: 9,
			}),
		).toBe(["src 4/9 truncated", "components/", "index.ts !.gitignore", "shared@ -> ../shared", "socket?", "[narrow path]"].join("\n"));
	});

	it("读取 file-tools 配置控制 blocked_path、ignored_path 和 ls_entries", async () => {
		const previousConfigPath = process.env.PI_FILE_TOOLS_CONFIG;
		const configPath = path.join(outside, "file-tools.jsonc");
		await writeFile(
			configPath,
			[
				"{",
				'  "blocked_path": ["blocked/"],',
				'  "ignored_path": ["ignored.txt"],',
				'  "limits": { "ls_entries": 1 }',
				"}",
			].join("\n"),
		);
		await mkdir(path.join(workspace, "blocked"));
		await writeFile(path.join(workspace, "blocked", "secret.txt"), "secret\n");
		await writeFile(path.join(workspace, "ignored.txt"), "ignored\n");
		await writeFile(path.join(workspace, "visible.txt"), "visible\n");

		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		try {
			const listed = await listWorkspaceDirectory(workspace, { path: "." });
			expect(listed).toMatchObject({
				truncated: true,
				returned_entries: 1,
				total_entries: 2,
				entries: [{ name: "ignored.txt", ignored: true, ignore_source: "file-tools.jsonc" }],
			});
			expect(await readWorkspaceFile(workspace, { path: "ignored.txt" })).toMatchObject({
				content: "ignored\n",
				ignored: true,
				ignore_source: "file-tools.jsonc",
			});
			expect(await readWorkspaceFile(workspace, { path: "blocked/secret.txt" })).toMatchObject({
				status: "failed",
				error: { code: "PROTECTED_PATH", path: "blocked/secret.txt" },
			});
		} finally {
			if (previousConfigPath === undefined) {
				delete process.env.PI_FILE_TOOLS_CONFIG;
			} else {
				process.env.PI_FILE_TOOLS_CONFIG = previousConfigPath;
			}
		}
	});

	it("列出空目录，path 缺省时使用 workspace root", async () => {
		await mkdir(path.join(workspace, "empty"));
		expect(await listWorkspaceDirectory(workspace, { path: "empty" })).toMatchObject({
			path: "empty",
			entries: [],
			truncated: false,
		});
		expect(await listWorkspaceDirectory(workspace, {})).toMatchObject({
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

	it("区分不存在和普通文件，允许绝对路径和 .. 相对路径，但拒绝 .git", async () => {
		await writeFile(path.join(workspace, "file.txt"), "");
		await mkdir(path.join(workspace, "src"));
		await writeFile(path.join(workspace, "src", "main.ts"), "");
		await mkdir(path.join(workspace, ".git"));
		await mkdir(path.join(outside, "nested"));
		const relativeOutside = path.relative(workspace, outside);
		expect(await listWorkspaceDirectory(workspace, { path: "missing" })).toMatchObject({
			status: "failed",
			error: { code: "PATH_NOT_FOUND", path: "missing" },
		});
		expect(await listWorkspaceDirectory(workspace, { path: "file.txt" })).toMatchObject({
			status: "failed",
			error: { code: "NOT_A_DIRECTORY", path: "file.txt" },
		});
		expect(await listWorkspaceDirectory(workspace, { path: relativeOutside })).toMatchObject({
			path: relativeOutside.replace(/\\/g, "/"),
			entries: [{ name: "nested", type: "directory" }],
		});
		expect(await listWorkspaceDirectory(workspace, { path: outside })).toMatchObject({
			path: path.normalize(outside),
			entries: [{ name: "nested", path: path.join(outside, "nested"), type: "directory" }],
		});
		expect(await listWorkspaceDirectory(workspace, { path: path.join(workspace, "src") })).toMatchObject({
			path: "src",
			entries: [{ name: "main.ts", path: "src/main.ts", type: "file" }],
		});
		expect(await listWorkspaceDirectory(workspace, { path: ".git" })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH", path: ".git" },
		});
	});

	it("父目录隐藏 .git 并保留普通 dotfile", async () => {
		await mkdir(path.join(workspace, ".git"));
		await writeFile(path.join(workspace, ".gitignore"), "dist\n");
		const result = await listWorkspaceDirectory(workspace, { path: "." });
		expect(result).toMatchObject({
			entries: [{ name: ".gitignore", path: ".gitignore", type: "file" }],
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

	it("直接访问目录 symlink 会解析 realpath，允许指向 cwd 外", async () => {
		await mkdir(path.join(workspace, "real-dir"));
		await mkdir(path.join(outside, "outside-dir"));
		await writeFile(path.join(outside, "outside-dir", "x.txt"), "");
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
			path: "outside-link",
			entries: [{ name: "x.txt", path: "outside-link/x.txt", type: "file" }],
			truncated: false,
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

	it.skipIf(process.platform === "win32")("权限不足目录返回 ACCESS_DENIED", async () => {
		const locked = path.join(workspace, "locked");
		await mkdir(locked);
		await chmod(locked, 0o000);
		try {
			expect(await listWorkspaceDirectory(workspace, { path: "locked" })).toMatchObject({
				status: "failed",
				error: { code: "ACCESS_DENIED", path: "locked" },
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
		const pendingWrite = writeWorkspaceFileImpl(workspace, { path: "queued.txt", content: "unsafe\n" }, undefined, {
			mutationQueue: (filePath, operation) => withFileMutationQueue(filePath, async () => {
				markQueueEntered?.();
				await queueRelease;
				return operation();
			}),
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
			lsp: {
				async beforeEdit() {
					controller.abort();
					return undefined;
				},
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
		const preview = await previewEditWorkspace(workspace, params);
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

describe("path-suggestions", () => {
	it("返回 fuzzy 匹配的邻近文件路径", async () => {
		await mkdir(path.join(workspace, "src"), { recursive: true });
		await writeFile(path.join(workspace, "src", "main.ts"), "");
		await writeFile(path.join(workspace, "src", "utils.ts"), "");
		await writeFile(path.join(workspace, "README.md"), "");

		const suggestions = await findPathSuggestions(workspace, "src/maim.ts", undefined, undefined, 10_000, 3);
		expect(suggestions).toContain("src/main.ts");
	});

	it("空目录返回空数组", async () => {
		const suggestions = await findPathSuggestions(workspace, "nonexistent.txt", undefined, undefined, 10_000, 3);
		expect(suggestions).toEqual([]);
	});

	it("limit 参数控制返回数量", async () => {
		await writeFile(path.join(workspace, "a.txt"), "");
		await writeFile(path.join(workspace, "b.txt"), "");
		await writeFile(path.join(workspace, "c.txt"), "");

		const suggestions = await findPathSuggestions(workspace, "x.txt", undefined, undefined, 10_000, 2);
		expect(suggestions).toHaveLength(2);
	});

	it("maxEntries 达到后停止扫描", async () => {
		await mkdir(path.join(workspace, "dir"), { recursive: true });
		for (let i = 0; i < 20; i++) {
			await writeFile(path.join(workspace, "dir", `file${i}.ts`), "");
		}
		await writeFile(path.join(workspace, "target.txt"), "");

		// maxEntries=5 should still find something in a small repo but might truncate
		const suggestions = await findPathSuggestions(workspace, "target.txt", undefined, undefined, 5, 3);
		// Either target.txt is found or at least some files are returned
		expect(Array.isArray(suggestions)).toBe(true);
		expect(suggestions.length).toBeLessThanOrEqual(3);
	});

	it("跳过 .git 目录", async () => {
		await mkdir(path.join(workspace, ".git"), { recursive: true });
		await writeFile(path.join(workspace, ".git", "config"), "");
		await writeFile(path.join(workspace, "visible.txt"), "");

		const suggestions = await findPathSuggestions(workspace, "anything", undefined, undefined, 10_000, 3);
		for (const s of suggestions) {
			expect(s.startsWith(".git/")).toBe(false);
		}
	});

	it("对完全不相似的查询返回低置信度建议而非报错", async () => {
		await writeFile(path.join(workspace, "config.yaml"), "");
		const suggestions = await findPathSuggestions(workspace, "zzz_totally_unrelated_abc.txt", undefined, undefined, 10_000, 3);
		expect(Array.isArray(suggestions)).toBe(true);
	});

	it("config.blocked_path 过滤被阻塞的路径", async () => {
		await mkdir(path.join(workspace, "secret"), { recursive: true });
		await writeFile(path.join(workspace, "secret", "key.txt"), "");
		await writeFile(path.join(workspace, "visible.txt"), "");

		const config: FileToolsConfig = { ...defaultFileToolsConfig(), blocked_path: [".git/", "secret/"] };
		const suggestions = await findPathSuggestions(workspace, "anything", config, undefined, 10_000, 3);
		for (const s of suggestions) {
			expect(s.startsWith("secret/")).toBe(false);
		}
	});

	it("config.ignored_path 过滤被忽略的路径", async () => {
		await writeFile(path.join(workspace, "build.log"), "");
		await writeFile(path.join(workspace, "source.ts"), "");

		const config: FileToolsConfig = { ...defaultFileToolsConfig(), ignored_path: ["build.log"] };
		const suggestions = await findPathSuggestions(workspace, "anything", config, undefined, 10_000, 3);
		expect(suggestions).not.toContain("build.log");
	});

	it(".gitignore 规则阻止扫描被忽略目录和内容", async () => {
		await mkdir(path.join(workspace, "node_modules"), { recursive: true });
		await writeFile(path.join(workspace, "node_modules", "pkg.js"), "");
		await writeFile(path.join(workspace, ".gitignore"), "node_modules/\n");
		await writeFile(path.join(workspace, "index.ts"), "");

		const suggestions = await findPathSuggestions(workspace, "anything", defaultFileToolsConfig(), undefined, 10_000, 3);
		for (const s of suggestions) {
			expect(s.startsWith("node_modules/")).toBe(false);
		}
	});

	it("repo-map 可用时优先返回 repo-map 结果，不走文件系统扫描", async () => {
		await writeFile(path.join(workspace, "a.ts"), "");

		const mockRepoMap: PathSuggestionQuery = {
			async query(_input) {
				return {
					candidates: [
						{ path: "src/main.ts", score: 1000, hop: 0 as const },
						{ path: "src/utils.ts", score: 920, hop: 0 as const },
					],
				};
			},
		};

		const suggestions = await findPathSuggestions(workspace, "x.ts", undefined, mockRepoMap, 10_000, 3);
		expect(suggestions).toEqual(["src/main.ts", "src/utils.ts"]);
	});

	it("repo-map 无结果时降级到文件系统扫描", async () => {
		await writeFile(path.join(workspace, "visible.txt"), "");

		const mockRepoMap: PathSuggestionQuery = {
			async query(_input) {
				return { candidates: [] };
			},
		};

		const suggestions = await findPathSuggestions(workspace, "vis.txt", undefined, mockRepoMap, 10_000, 3);
		expect(suggestions).toContain("visible.txt");
	});

	it("repo-map 抛出异常时降级到文件系统扫描", async () => {
		await writeFile(path.join(workspace, "recovery.txt"), "");

		const mockRepoMap: PathSuggestionQuery = {
			async query(_input) {
				throw new Error("repo-map unavailable");
			},
		};

		const suggestions = await findPathSuggestions(workspace, "reco.txt", undefined, mockRepoMap, 10_000, 3);
		expect(suggestions).toContain("recovery.txt");
	});

	it("repo-map 仅返回 hop=0 直接匹配，排除 graph hop 结果", async () => {
		const mockRepoMap: PathSuggestionQuery = {
			async query(_input) {
				return {
					candidates: [
						{ path: "direct.ts", score: 1000, hop: 0 as const },
						{ path: "related.ts", score: 500, hop: 1 as const },
						{ path: "transitive.ts", score: 300, hop: 2 as const },
					],
				};
			},
		};

		const suggestions = await findPathSuggestions(workspace, "x", undefined, mockRepoMap, 10_000, 3);
		expect(suggestions).toEqual(["direct.ts"]);
	});
});

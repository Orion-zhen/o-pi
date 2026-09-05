import { chmod, mkdir, readFile, readdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listDirectory } from "../../src/file-tools/ls/command.js";
import { isLsSuccess } from "../../src/file-tools/ls/guards.js";
import { formatCompactLsResult } from "../../src/file-tools/ls/presenter.js";
import { executeLs } from "../../src/file-tools/pi/adapters/ls.js";
import type { LsParams, LsSuccess } from "../../src/file-tools/ls/types.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { isFailed, type ToolOutcome } from "../../src/file-tools/shared/result.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";
import { readWorkspaceFile } from "../helpers/read-tool.js";
import { expectFailure } from "./result-fixtures.js";

let workspace: string;
let outside: string;
let host: FileToolsHost;
const workspaceTemp = useTempDir("o-pi-ls-workspace-");
const outsideTemp = useTempDir("o-pi-ls-outside-");
const pathAccess = { mounts: [], protectedRoots: [], managedSchemes: ["skill"] } as const;
preserveEnv("PI_FILE_TOOLS_CONFIG");

beforeEach(() => {
	workspace = workspaceTemp.path;
	outside = outsideTemp.path;
	host = new FileToolsHost();
});

afterEach(() => { host.dispose(); });

function expectLsSuccess(result: ToolOutcome<LsSuccess>): LsSuccess {
	if ("status" in result) throw new Error(`ls failed: ${result.error.code}`);
	return result;
}

async function listWorkspaceDirectory(cwd: string, params: LsParams): Promise<ToolOutcome<LsSuccess>> {
	const opened = await host.open({ cwd, sessionId: "ls-test" });
	if (isFailed(opened)) return opened;
	try {
		return await listDirectory(params, {
			filesystem: opened.filesystem,
			operation: opened.context,
			entryLimit: opened.limits.ls_entries,
		});
	} finally {
		opened.dispose();
	}
}

describe("ls", () => {
	it("仅由 Pi adapter 添加 native 截断标记", async () => {
		const previousConfigPath = process.env.PI_FILE_TOOLS_CONFIG;
		const configPath = path.join(outside, "native-details-file-tools.jsonc");
		await writeFile(configPath, JSON.stringify({ limits: { ls_entries: 1 } }));
		await writeFile(path.join(workspace, "a.txt"), "");
		await writeFile(path.join(workspace, "b.txt"), "");
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		try {
			const commandResult = await listWorkspaceDirectory(workspace, {});
			expect(commandResult).toMatchObject({ truncated: true, returned_entries: 1 });
			expect(commandResult).not.toHaveProperty("entryLimitReached");

			const piResult = await executeLs({}, { cwd: workspace, sessionId: "native-details", host, pathAccess });
			expect(piResult.details).toMatchObject({ truncated: true, entryLimitReached: 1 });
		} finally {
			if (previousConfigPath === undefined) delete process.env.PI_FILE_TOOLS_CONFIG;
			else process.env.PI_FILE_TOOLS_CONFIG = previousConfigPath;
		}
	});

	it("在打开 invocation 前响应取消", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await executeLs({}, {
			cwd: workspace,
			sessionId: "aborted-ls",
			signal: controller.signal,
			host,
			pathAccess,
		});
		expect(result.details).toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
	});

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
				continuation_hint: "List a more specific subdirectory.",
			}),
		).toBe(["src 4/9 truncated", "components/", "index.ts !.gitignore", "shared@ -> ../shared", "socket?", "[narrow path]"].join("\n"));
	});

	it("只接受字段完整的截断结果", () => {
		expect(isLsSuccess({ path: ".", entries: [], truncated: false })).toBe(true);
		expect(isLsSuccess({
			path: ".",
			entries: [],
			truncated: true,
			returned_entries: 0,
			total_entries: 1,
			continuation_hint: "List a more specific subdirectory.",
		})).toBe(true);
		expect(isLsSuccess({ path: ".", entries: [], truncated: true })).toBe(false);
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
			expectFailure(await readWorkspaceFile(workspace, { path: "blocked/secret.txt" }), { code: "PROTECTED_PATH", path: "blocked/secret.txt" });
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
		expectFailure(await listWorkspaceDirectory(workspace, { path: "missing" }), { code: "PATH_NOT_FOUND", path: "missing" });
		expectFailure(await listWorkspaceDirectory(workspace, { path: "file.txt" }), { code: "NOT_A_DIRECTORY", path: "file.txt" });
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
		expectFailure(await listWorkspaceDirectory(workspace, { path: ".git" }), { code: "PROTECTED_PATH", path: ".git" });
	});

	it("保留非规则文件 soft-ignore 的来源类型", async () => {
		const configPath = path.join(outside, "builtin-file-tools.jsonc");
		await writeFile(configPath, JSON.stringify({ blocked_path: [], ignored_path: [], ignore: { builtin_profile: "minimal" } }));
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await mkdir(path.join(workspace, "node_modules"));
		expect(await listWorkspaceDirectory(workspace, {})).toMatchObject({
			entries: [{ name: "node_modules", ignored: true, ignore_source: "builtin" }],
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
			expectFailure(await listWorkspaceDirectory(workspace, { path: "locked" }), { code: "ACCESS_DENIED", path: "locked" });
		} finally {
			await chmod(locked, 0o700);
		}
	});

});

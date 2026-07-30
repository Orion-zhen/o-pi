import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { FindTool } from "../../src/file-tools/find/command.js";
import { createFindQueryPlan } from "../../src/file-tools/find/query.js";
import {
	rankFindEntries,
	rankFindEntriesAsync,
	rankFindEntriesLimitedAsync,
} from "../../src/file-tools/find/ranker.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import type { FindMatch, FindSuccess } from "../../src/file-tools/find/types.js";
import { isFailed, type ToolOutcome } from "../../src/file-tools/shared/result.js";
import { FileSystemRuntime } from "../../src/filesystem/runtime.js";
import { NodeNativeFileSystem } from "../../src/filesystem/platform/node/native-filesystem.js";
import { countTextTokensSync } from "../../src/token-counter.js";
import { overrideNativeFileSystem } from "../filesystem/fixtures.js";
import { findWorkspaceFiles } from "../helpers/find-tool.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let workspace: string;
let outside: string;
const workspaceTemp = useTempDir("o-pi-find-");
const outsideTemp = useTempDir("o-pi-find-outside-");
preserveEnv("PI_FILE_TOOLS_CONFIG");

beforeEach(async () => {
	workspace = workspaceTemp.path;
	outside = outsideTemp.path;
	const configPath = path.join(outside, "file-tools.jsonc");
	await writeFile(configPath, JSON.stringify({
		blocked_path: [".git/"],
		ignored_path: [],
		limits: { find_result_limit: 50 },
		ignore: { builtin_profile: "none", gitignore: false },
	}));
	process.env.PI_FILE_TOOLS_CONFIG = configPath;
});

function success(result: ToolOutcome<FindSuccess>): FindSuccess {
	if ("status" in result) throw new Error(`find failed: ${result.error.code}: ${result.error.message}`);
	return result;
}

function paths(matches: readonly FindMatch[]): string[] {
	return matches.map((match) => match.path);
}

async function writeFixture(filePath: string): Promise<void> {
	const absolutePath = path.join(workspace, ...filePath.split("/"));
	await mkdir(path.dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, "");
}

describe("find", () => {
	it("校验 query、path 和独立 glob", async () => {
		for (const params of [
			{ query: "" },
			{ query: "a\0b" },
			{ query: "a\nb" },
			{ query: "| auth" },
			{ query: "auth |" },
			{ query: "auth | | session" },
			{ query: "x", path: [] },
			{ query: "x", path: [""] },
			{ query: "x", glob: "" },
			{ query: "x", glob: "a\0b" },
		]) {
			expect(await findWorkspaceFiles(workspace, params)).toMatchObject({
				status: "failed",
				error: { code: expect.stringMatching(/^INVALID_/) },
			});
		}
	});

	it("普通 term 使用 fuzzy subsequence，多 term 为 AND", async () => {
		await writeFixture("src/auth/service.ts");
		await writeFixture("src/auth/session.ts");
		await writeFixture("src/billing/service.ts");
		await writeFixture("docs/authorization.md");

		const subsequence = success(await findWorkspaceFiles(workspace, { query: "asrv" }));
		expect(paths(subsequence.details.matches)[0]).toBe("src/auth/service.ts");

		const terms = success(await findWorkspaceFiles(workspace, { query: "auth service" }));
		expect(paths(terms.details.matches)).toEqual(["src/auth/service.ts"]);
		expect(terms.details).toMatchObject({
			status: "success",
			total_candidates: 8,
			total_matches: 1,
			truncated_by: [],
		});
	});

	it("支持 fzf exact、boundary、prefix、suffix、equal、inverse 和 OR", async () => {
		await writeFixture("src/auth-service.ts");
		await writeFixture("src/auth/service.ts");
		await writeFixture("src/authorization.ts");
		await writeFixture("src/auth_handler.ts");
		await writeFixture("src/session.ts");
		await writeFixture("tests/auth-service.test.ts");

		expect(paths(success(await findWorkspaceFiles(workspace, { query: "'auth-service" })).details.matches)).toEqual([
			"src/auth-service.ts",
			"tests/auth-service.test.ts",
		]);
		const boundaryPaths = paths(success(await findWorkspaceFiles(workspace, { query: "'auth'" })).details.matches);
		expect(boundaryPaths).toContain("src/auth_handler.ts");
		expect(boundaryPaths).not.toContain("src/authorization.ts");
		expect(paths(success(await findWorkspaceFiles(workspace, { query: "^src .ts$" })).details.matches)).toEqual(
			expect.arrayContaining([
				"src/auth-service.ts",
				"src/auth/service.ts",
				"src/auth_handler.ts",
				"src/authorization.ts",
				"src/session.ts",
			]),
		);
		expect(paths(success(await findWorkspaceFiles(workspace, { query: "^src/auth/service.ts$" })).details.matches)).toEqual([
			"src/auth/service.ts",
		]);
		expect(paths(success(await findWorkspaceFiles(workspace, { query: "auth !test" })).details.matches)).not.toContain(
			"tests/auth-service.test.ts",
		);
		expect(paths(success(await findWorkspaceFiles(workspace, { query: "auth !'tst" })).details.matches)).not.toContain(
			"tests/auth-service.test.ts",
		);
		expect(paths(success(await findWorkspaceFiles(workspace, { query: "auth | session" })).details.matches)).toEqual(
			expect.arrayContaining([
				"src/auth-service.ts",
				"src/auth/service.ts",
				"src/authorization.ts",
				"src/session.ts",
				"tests/auth-service.test.ts",
			]),
		);
	});

	it("escaped space 作为一个 fuzzy term，smart case 按 term 生效", async () => {
		await writeFixture("src/auth service.ts");
		await writeFixture("src/auth-service.ts");
		await writeFixture("src/café.ts");
		await writeFixture("src/upper/AuthService.ts");
		await writeFixture("src/lower/authservice.ts");

		const escaped = success(await findWorkspaceFiles(workspace, { query: "auth\\ service" }));
		expect(paths(escaped.details.matches)).toEqual(["src/auth service.ts"]);

		const smart = success(await findWorkspaceFiles(workspace, { query: "AuthService" }));
		expect(paths(smart.details.matches)).toEqual(["src/upper/AuthService.ts"]);
		expect(paths(success(await findWorkspaceFiles(workspace, { query: "cafe" })).details.matches)).toEqual(["src/café.ts"]);
	});

	it("path scheme 在同等相关性下优先 basename 命中", async () => {
		await writeFixture("src/auth/handler.ts");
		await writeFixture("src/core/auth.ts");
		await writeFixture("src/authentication.ts");

		const result = success(await findWorkspaceFiles(workspace, { query: "auth", glob: "**/*.ts" }));
		expect(paths(result.details.matches)[0]).toBe("src/core/auth.ts");
	});

	it("glob 只筛候选，不从 query 推断", async () => {
		await writeFixture("src/auth.ts");
		await writeFixture("src/auth.tsx");
		await writeFixture("docs/auth.md");

		const filtered = success(await findWorkspaceFiles(workspace, {
			query: "auth",
			glob: "**/*.ts",
		}));
		expect(filtered.details.glob).toBe("**/*.ts");
		expect(paths(filtered.details.matches)).toEqual(["src/auth.ts"]);
		expect(paths(success(await findWorkspaceFiles(workspace, {
			query: "auth",
			glob: "src/**/*.ts",
		})).details.matches)).toEqual(["src/auth.ts"]);

		const notInferred = success(await findWorkspaceFiles(workspace, { query: "*.ts" }));
		expect(notInferred.details.total_matches).toBe(0);
	});

	it("basename glob 递归筛选，文件和目录都可成为结果", async () => {
		await writeFixture("src/deep/auth.ts");
		await writeFixture("src/deep/auth.js");
		await mkdir(path.join(workspace, "packages", "auth"), { recursive: true });

		const files = success(await findWorkspaceFiles(workspace, { query: "auth", glob: "*.ts" }));
		expect(paths(files.details.matches)).toEqual(["src/deep/auth.ts"]);

		const directory = success(await findWorkspaceFiles(workspace, { query: "packages auth" }));
		expect(directory.details.matches).toContainEqual({ path: "packages/auth", kind: "directory" });
		expect(directory.content).toContain("packages/auth/");
	});

	it("多个 scope 按 union 合并、scope-relative 评分并去重嵌套 scope", async () => {
		await writeFixture("src/lib/auth.ts");
		await writeFixture("src/session.ts");
		await writeFixture("tests/auth.test.ts");

		const union = success(await findWorkspaceFiles(workspace, {
			query: "auth",
			path: ["src", "tests"],
		}));
		expect(union.details.paths).toEqual(["src", "tests"]);
		expect(paths(union.details.matches)).toEqual(["src/lib/auth.ts", "tests/auth.test.ts"]);

		const nested = success(await findWorkspaceFiles(workspace, {
			query: "ts",
			path: ["src/lib", "src", path.join(workspace, "src"), "src"],
		}));
		expect(nested.details.paths).toEqual(["src"]);
		expect(new Set(paths(nested.details.matches)).size).toBe(nested.details.matches.length);
	});

	it("部分 scope 失败时保留结果，全部失败时返回结构化错误", async () => {
		await writeFixture("src/available.ts");

		const partial = success(await findWorkspaceFiles(workspace, {
			query: "available",
			path: ["src", "missing"],
		}));
		expect(paths(partial.details.matches)).toEqual(["src/available.ts"]);
		expect(partial.content).toContain("partial; scope_errors=missing:PATH_NOT_FOUND");
		expect(partial.details.scope_errors).toMatchObject([
			{ path: "missing", error: { code: "PATH_NOT_FOUND" } },
		]);

		expect(await findWorkspaceFiles(workspace, {
			query: "available",
			path: ["missing", "also-missing"],
		})).toMatchObject({
			status: "failed",
			error: { code: "PATH_NOT_FOUND", details: { scope_errors: expect.any(Array) } },
		});
	});

	it("自动发现遵守 ignore，显式 scope 可进入 soft ignored 目录", async () => {
		await mkdir(path.join(workspace, "ignored"), { recursive: true });
		await writeFile(path.join(workspace, ".piignore"), "ignored/\n");
		await writeFile(path.join(workspace, "ignored", "auth.ts"), "");

		const automatic = success(await findWorkspaceFiles(workspace, { query: "auth" }));
		expect(automatic.details.matches).toEqual([]);
		expect(automatic.details.stats.ignored_entries).toBeGreaterThan(0);

		const explicit = success(await findWorkspaceFiles(workspace, {
			query: "auth",
			path: ["ignored"],
		}));
		expect(paths(explicit.details.matches)).toEqual(["ignored/auth.ts"]);
	});

	it("blocked path 和 symlink 不进入候选，普通 dotfile 正常搜索", async () => {
		await mkdir(path.join(workspace, ".git"), { recursive: true });
		await mkdir(path.join(workspace, "real"), { recursive: true });
		await writeFile(path.join(workspace, ".git", "auth"), "");
		await writeFile(path.join(workspace, ".env.auth"), "");
		await writeFile(path.join(workspace, "real", "auth.ts"), "");
		try {
			await symlink(path.join(workspace, "real", "auth.ts"), path.join(workspace, "auth-link.ts"), "file");
			await symlink(path.join(workspace, "real"), path.join(workspace, "real-link"), "dir");
		} catch {
			return;
		}

		const result = success(await findWorkspaceFiles(workspace, { query: "auth" }));
		expect(paths(result.details.matches)).toContain(".env.auth");
		expect(paths(result.details.matches)).toContain("real/auth.ts");
		expect(paths(result.details.matches)).not.toContain(".git/auth");
		expect(paths(result.details.matches)).not.toContain("auth-link.ts");
		expect(paths(result.details.matches)).not.toContain("real-link/auth.ts");
		expect(await findWorkspaceFiles(workspace, { query: "auth", path: [".git"] })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH" },
		});
	});

	it("允许 workspace 外显式 scope，输出规范化绝对路径", async () => {
		await mkdir(path.join(outside, "external"), { recursive: true });
		await writeFile(path.join(outside, "external", "auth.ts"), "");
		const expectedPath = path.join(outside, "external", "auth.ts").replace(/\\/gu, "/");

		const result = success(await findWorkspaceFiles(workspace, {
			query: "auth",
			path: [path.join(outside, "external")],
		}));
		expect(result.details.matches).toEqual([{
			path: expectedPath,
			kind: "file",
		}]);
		const relative = success(await findWorkspaceFiles(workspace, {
			query: "auth",
			path: [path.relative(workspace, path.join(outside, "external"))],
		}));
		expect(relative.details.matches).toEqual([{ path: expectedPath, kind: "file" }]);
	});

	it("结果、深度和输出限制来自配置，截断原因准确且顺序稳定", async () => {
		const configPath = path.join(outside, "limits.jsonc");
		await writeFile(configPath, JSON.stringify({
			ignore: { builtin_profile: "none", gitignore: false },
			limits: {
				find_output_token_budget: 40,
				find_result_limit: 3,
				find_max_depth: 2,
			},
		}));
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		for (let index = 0; index < 20; index += 1) {
			await writeFixture(`many/very-long-auth-file-${String(index).padStart(2, "0")}.ts`);
		}
		await writeFixture("many/deep/auth-hidden.ts");

		const first = success(await findWorkspaceFiles(workspace, { query: "auth" }));
		const second = success(await findWorkspaceFiles(workspace, { query: "auth" }));
		expect(first).toEqual(second);
		expect(first.details.total_matches).toBe(20);
		expect(first.details.returned_matches).toBe(3);
		expect(first.details.truncated_by).toEqual(["depth_limit", "result_limit", "output_limit"]);
		expect(paths(first.details.matches)).not.toContain("many/deep/auth-hidden.ts");
		expect(countTextTokensSync(first.content).tokens).toBeLessThanOrEqual(40);
	});

	it("路径发现不为每个普通文件读取 metadata 或解析 realpath", async () => {
		const fileCount = 64;
		const directoryCount = 4;
		for (let index = 0; index < fileCount; index += 1) {
			await writeFixture(`bucket-${index % directoryCount}/target-${String(index).padStart(2, "0")}.ts`);
		}
		const base = new NodeNativeFileSystem();
		const calls = { lstat: 0, realpath: 0 };
		const native = overrideNativeFileSystem({
			async lstat(file, options) {
				calls.lstat += 1;
				return await base.lstat(file, options);
			},
			async realpath(file, options) {
				calls.realpath += 1;
				return await base.realpath(file, options);
			},
		}, base);
		const host = new FileToolsHost({ filesystem: new FileSystemRuntime({ native }) });
		const tool = new FindTool();
		try {
			const opened = await host.open({ cwd: workspace, sessionId: "find-path-discovery" });
			if (isFailed(opened)) throw new Error(opened.error.message);
			try {
				calls.lstat = 0;
				calls.realpath = 0;
				const result = success(await tool.execute({ query: "target" }, {
					filesystem: opened.filesystem,
					operation: opened.context,
					limits: opened.limits,
				}));
				expect(result.details).toMatchObject({
					total_candidates: fileCount + directoryCount,
					total_matches: fileCount,
				});
				expect(calls.lstat).toBeLessThan(fileCount / 4);
				expect(calls.realpath).toBeLessThan(fileCount / 4);
			} finally {
				opened.dispose();
			}
		} finally {
			tool.dispose();
			host.dispose();
		}
	});

	it("AbortSignal 和 tool dispose 都终止调用", async () => {
		const controller = new AbortController();
		controller.abort();
		expect(await findWorkspaceFiles(workspace, { query: "auth" }, controller.signal)).toMatchObject({
			status: "failed",
			error: { code: "OPERATION_ABORTED" },
		});

		const host = new FileToolsHost();
		const tool = new FindTool();
		const opened = await host.open({ cwd: workspace, sessionId: "disposed-find" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		try {
			tool.dispose();
			tool.dispose();
			expect(await tool.execute({ query: "auth" }, {
				filesystem: opened.filesystem,
				operation: opened.context,
				limits: opened.limits,
			})).toMatchObject({
				status: "failed",
				error: { code: "OPERATION_ABORTED", message: "find is shut down." },
			});
		} finally {
			opened.dispose();
			host.dispose();
		}
	});

	it("大型候选集排名会让出事件循环并响应取消", async () => {
		const plan = createFindQueryPlan("parser runtime");
		if ("status" in plan) throw new Error(plan.error.message);
		const entries = Array.from({ length: 1_000 }, (_value, index) => {
			const searchPath = `packages/component-${index}/parser-runtime-${index}.ts`;
			return {
				path: searchPath,
				searchPath,
				kind: "file" as const,
				scopeOrder: 0,
			};
		});
		const controller = new AbortController();
		const pending = rankFindEntriesAsync(entries, plan, controller.signal);
		queueMicrotask(() => controller.abort());
		expect(await pending).toBeUndefined();
	});

	it("有界排名保留全量命中数并返回与完整排序相同的 relevance 前缀", async () => {
		const plan = createFindQueryPlan("parser runtime");
		if ("status" in plan) throw new Error(plan.error.message);
		const entries = Array.from({ length: 200 }, (_value, index) => {
			const searchPath = `packages/component-${index % 17}/parser-runtime-${String(199 - index).padStart(3, "0")}.ts`;
			return {
				path: searchPath,
				searchPath,
				kind: "file" as const,
				scopeOrder: 0,
			};
		});
		const complete = rankFindEntries(entries, plan);
		const limited = await rankFindEntriesLimitedAsync(entries, plan, 7);
		expect(limited).toEqual({
			ranked: complete.slice(0, 7),
			totalMatches: complete.length,
		});
	});
});

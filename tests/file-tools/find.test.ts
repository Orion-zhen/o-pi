import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FindTool } from "../../src/file-tools/find/command.js";
import { createFindQueryPlan } from "../../src/file-tools/find/query.js";
import {
	createLimitedFindRanker,
	rankFindEntries,
	rankFindEntriesAsync,
	rankFindEntriesLimitedAsync,
} from "../../src/file-tools/find/ranker.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import type { FindParams, FindSuccess } from "../../src/file-tools/find/types.js";
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
const resources: Array<{ dispose(): void }> = [];
preserveEnv("PI_FILE_TOOLS_CONFIG");

beforeEach(async () => {
	workspace = workspaceTemp.path;
	outside = outsideTemp.path;
	await useConfig("file-tools", {
		blocked_path: [".git/"],
		ignored_path: [],
		limits: { find_result_limit: 50 },
		ignore: { builtin_profile: "none", gitignore: false },
	});
});

afterEach(() => {
	for (const resource of resources.splice(0).reverse()) resource.dispose();
});

function expectSuccess<T>(result: ToolOutcome<T>): T {
	if (isFailed(result)) throw new Error(`find failed: ${result.error.code}`);
	return result;
}

async function find(params: FindParams): Promise<FindSuccess> {
	return expectSuccess(await findWorkspaceFiles(workspace, params));
}

async function findPaths(params: FindParams): Promise<string[]> {
	return paths(await find(params));
}

function paths(result: FindSuccess): string[] {
	return result.details.matches.map((match) => match.path);
}

type Fixture = string | readonly [path: string, content: string];

async function writeFixtures(...fixtures: Fixture[]): Promise<void> {
	for (const fixture of fixtures) {
		const [filePath, content] = typeof fixture === "string" ? [fixture, ""] : fixture;
		const absolutePath = path.join(workspace, ...filePath.split("/"));
		await mkdir(path.dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, content);
	}
}

async function useConfig(name: string, config: Record<string, unknown>): Promise<void> {
	const configPath = path.join(outside, `${name}.jsonc`);
	await writeFile(configPath, JSON.stringify(config));
	process.env.PI_FILE_TOOLS_CONFIG = configPath;
}

function track<T extends { dispose(): void }>(resource: T): T {
	resources.push(resource);
	return resource;
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
		await writeFixtures("src/auth/service.ts", "src/auth/session.ts", "src/billing/service.ts", "docs/authorization.md");

		expect((await findPaths({ query: "asrv" }))[0]).toBe("src/auth/service.ts");

		const terms = await find({ query: "auth service" });
		expect(paths(terms)).toEqual(["src/auth/service.ts"]);
		expect(terms.details).toMatchObject({
			total_candidates: 8,
			total_matches: 1,
			truncated_by: [],
		});
	});

	it("支持 fzf exact、boundary、prefix、suffix、equal、inverse 和 OR", async () => {
		await writeFixtures(
			"src/auth-service.ts", "src/auth/service.ts", "src/authorization.ts",
			"src/auth_handler.ts", "src/session.ts", "tests/auth-service.test.ts",
		);

		expect(await findPaths({ query: "'auth-service" })).toEqual([
			"src/auth-service.ts",
			"tests/auth-service.test.ts",
		]);
		const boundaryPaths = await findPaths({ query: "'auth'" });
		expect(boundaryPaths).toContain("src/auth_handler.ts");
		expect(boundaryPaths).not.toContain("src/authorization.ts");
		expect(await findPaths({ query: "^src .ts$" })).toEqual(expect.arrayContaining([
			"src/auth-service.ts",
			"src/auth/service.ts",
			"src/auth_handler.ts",
			"src/authorization.ts",
			"src/session.ts",
		]));
		expect(await findPaths({ query: "^src/auth/service.ts$" })).toEqual(["src/auth/service.ts"]);
		for (const query of ["auth !test", "auth !'tst"]) {
			expect(await findPaths({ query })).not.toContain("tests/auth-service.test.ts");
		}
		expect(await findPaths({ query: "auth | session" })).toEqual(expect.arrayContaining([
			"src/auth-service.ts",
			"src/auth/service.ts",
			"src/authorization.ts",
			"src/session.ts",
			"tests/auth-service.test.ts",
		]));
	});

	it("escaped space 作为一个 fuzzy term，smart case 按 term 生效", async () => {
		await writeFixtures(
			"src/auth service.ts", "src/auth-service.ts", "src/café.ts",
			"src/upper/AuthService.ts", "src/lower/authservice.ts",
		);

		expect(await findPaths({ query: "auth\\ service" })).toEqual(["src/auth service.ts"]);
		expect(await findPaths({ query: "AuthService" })).toEqual(["src/upper/AuthService.ts"]);
		expect(await findPaths({ query: "cafe" })).toEqual(["src/café.ts"]);
	});

	it("path scheme 在同等相关性下优先 basename 命中", async () => {
		await writeFixtures("src/auth/handler.ts", "src/core/auth.ts", "src/authentication.ts");

		expect((await findPaths({ query: "auth", glob: "**/*.ts" }))[0]).toBe("src/core/auth.ts");
	});

	it("glob 只筛候选，不从 query 推断", async () => {
		await writeFixtures("src/auth.ts", "src/auth.tsx", "docs/auth.md");

		const filtered = await find({ query: "auth", glob: "**/*.ts" });
		expect(filtered.details.glob).toBe("**/*.ts");
		expect(paths(filtered)).toEqual(["src/auth.ts"]);
		expect(await findPaths({ query: "auth", glob: "src/**/*.ts" })).toEqual(["src/auth.ts"]);

		const notInferred = await find({ query: "*.ts" });
		expect(notInferred.details.total_matches).toBe(0);
	});

	it("basename glob 递归筛选，文件和目录都可成为结果", async () => {
		await writeFixtures("src/deep/auth.ts", "src/deep/auth.js");
		await mkdir(path.join(workspace, "packages", "auth"), { recursive: true });

		expect(await findPaths({ query: "auth", glob: "*.ts" })).toEqual(["src/deep/auth.ts"]);

		const directory = await find({ query: "packages auth" });
		expect(directory.details.matches).toContainEqual({ path: "packages/auth", kind: "directory" });
	});

	it("多个 scope 按 union 合并、scope-relative 评分并去重嵌套 scope", async () => {
		await writeFixtures("src/lib/auth.ts", "src/session.ts", "tests/auth.test.ts");

		const union = await find({ query: "auth", path: ["src", "tests"] });
		expect(union.details.paths).toEqual(["src", "tests"]);
		expect(paths(union)).toEqual(["src/lib/auth.ts", "tests/auth.test.ts"]);

		const nested = await find({ query: "ts", path: ["src/lib", "src", path.join(workspace, "src"), "src"] });
		expect(nested.details.paths).toEqual(["src"]);
		expect(new Set(paths(nested)).size).toBe(nested.details.matches.length);
	});

	it("部分 scope 失败时保留结果，全部失败时返回结构化错误", async () => {
		await writeFixtures("src/available.ts");

		const partial = await find({ query: "available", path: ["src", "missing"] });
		expect(paths(partial)).toEqual(["src/available.ts"]);
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
		await writeFixtures([".piignore", "ignored/\n"], "ignored/auth.ts");

		const automatic = await find({ query: "auth" });
		expect(automatic.details.matches).toEqual([]);
		expect(automatic.details.stats.ignored_entries).toBeGreaterThan(0);

		const explicit = await find({ query: "auth", path: ["ignored"] });
		expect(paths(explicit)).toEqual(["ignored/auth.ts"]);
	});

	it("增量加载嵌套 ignore，并保留跨来源重新包含语义", async () => {
		await useConfig("nested-ignore", {
			blocked_path: [".git/"],
			ignored_path: [],
			ignore: {
				builtin_profile: "none",
				piignore: true,
				gitignore: true,
				git_tracked_files_bypass: false,
			},
		});
		await writeFixtures(
			[".gitignore", "pkg/cache/\n*.tmp\n"],
			["pkg/.gitignore", "!keep.tmp\nlocal.log\n"],
			["pkg/cache/.piignore", "!revived.ts\n"],
			"pkg/drop.tmp", "pkg/keep.tmp", "pkg/local.log", "pkg/visible.ts",
			"pkg/cache/revived.ts", "pkg/cache/hidden.ts",
		);

		const result = await find({ query: "pkg" });
		expect(paths(result)).toEqual(expect.arrayContaining([
			"pkg",
			"pkg/keep.tmp",
			"pkg/visible.ts",
			"pkg/cache/revived.ts",
		]));
		for (const ignored of ["pkg/drop.tmp", "pkg/local.log", "pkg/cache/hidden.ts"]) {
			expect(paths(result)).not.toContain(ignored);
		}
	});

	it("blocked path 和 symlink 不进入候选，普通 dotfile 正常搜索", async () => {
		await writeFixtures(".git/auth", ".env.auth", "real/auth.ts");
		try {
			await symlink(path.join(workspace, "real", "auth.ts"), path.join(workspace, "auth-link.ts"), "file");
			await symlink(path.join(workspace, "real"), path.join(workspace, "real-link"), "dir");
		} catch {
			return;
		}

		const matches = await findPaths({ query: "auth" });
		expect(matches).toContain(".env.auth");
		expect(matches).toContain("real/auth.ts");
		expect(matches).not.toContain(".git/auth");
		expect(matches).not.toContain("auth-link.ts");
		expect(matches).not.toContain("real-link/auth.ts");
		expect(await findWorkspaceFiles(workspace, { query: "auth", path: [".git"] })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH" },
		});
	});

	it("允许 workspace 外显式 scope，输出规范化绝对路径", async () => {
		await mkdir(path.join(outside, "external"), { recursive: true });
		await writeFile(path.join(outside, "external", "auth.ts"), "");
		const expectedPath = path.join(outside, "external", "auth.ts").replace(/\\/gu, "/");

		expect(await findPaths({ query: "auth", path: [path.join(outside, "external")] })).toEqual([expectedPath]);
		expect(await findPaths({
			query: "auth",
			path: [path.relative(workspace, path.join(outside, "external"))],
		})).toEqual([expectedPath]);
	});

	it("多个 scope 共享 entry budget，达到边界后返回部分排名", async () => {
		await useConfig("entry-limit", {
			ignore: { builtin_profile: "none", gitignore: false },
			limits: { find_max_entries: 2 },
		});
		await writeFixtures("first/auth-a.ts", "second/auth-b.ts", "second/auth-c.ts");

		const result = await find({ query: "auth", path: ["first", "second"] });
		expect(paths(result)).toEqual(["first/auth-a.ts", "second/auth-b.ts"]);
		expect(result.details.total_candidates).toBe(2);
		expect(result.details.truncated_by).toEqual(["entry_limit"]);
		expect(result.content).toContain("truncated=entry_limit");
	});

	it("结果、深度和输出限制来自配置，截断原因准确且顺序稳定", async () => {
		await useConfig("limits", {
			ignore: { builtin_profile: "none", gitignore: false },
			limits: {
				find_output_token_budget: 40,
				find_result_limit: 3,
				find_max_depth: 2,
			},
		});
		await writeFixtures(
			...Array.from(
				{ length: 20 },
				(_value, index) => `many/very-long-auth-file-${String(index).padStart(2, "0")}.ts`,
			),
			"many/deep/auth-hidden.ts",
		);

		const first = await find({ query: "auth" });
		const second = await find({ query: "auth" });
		expect(first).toEqual(second);
		expect(first.details.total_matches).toBe(20);
		expect(first.details.returned_matches).toBe(3);
		expect(first.details.truncated_by).toEqual(["depth_limit", "result_limit", "output_limit"]);
		expect(paths(first)).not.toContain("many/deep/auth-hidden.ts");
		expect(countTextTokensSync(first.content).tokens).toBeLessThanOrEqual(40);
	});

	it("路径发现不为 readdir 已分类的普通文件和目录读取 metadata 或解析 realpath", async () => {
		const fileCount = 64;
		const directoryCount = 4;
		await writeFixtures(...Array.from(
			{ length: fileCount },
			(_value, index) => `bucket-${index % directoryCount}/target-${String(index).padStart(2, "0")}.ts`,
		));
		const base = new NodeNativeFileSystem();
		const calls = { lstat: 0, realpath: 0, readdir: 0 };
		const native = overrideNativeFileSystem({
			async lstat(file, options) {
				calls.lstat += 1;
				return await base.lstat(file, options);
			},
			async realpath(file, options) {
				calls.realpath += 1;
				return await base.realpath(file, options);
			},
			async readdir(directory, options) {
				calls.readdir += 1;
				return await base.readdir(directory, options);
			},
		}, base);
		const host = track(new FileToolsHost({ filesystem: new FileSystemRuntime({ native }) }));
		const tool = track(new FindTool());
		const opened = track(expectSuccess(await host.open({ cwd: workspace, sessionId: "find-path-discovery" })));
		expect(calls.readdir).toBe(0);
		expect(calls.lstat).toBeLessThan(10);
		calls.lstat = 0;
		calls.realpath = 0;
		calls.readdir = 0;
		const result = expectSuccess(await tool.execute({ query: "target" }, {
			filesystem: opened.filesystem,
			operation: opened.context,
			limits: opened.limits,
		}));
		expect(result.details).toMatchObject({
			total_candidates: fileCount + directoryCount,
			total_matches: fileCount,
		});
		expect(calls).toEqual({ lstat: 0, realpath: 0, readdir: directoryCount + 1 });
	});

	it("AbortSignal 和 tool dispose 都终止调用", async () => {
		const controller = new AbortController();
		controller.abort();
		expect(await findWorkspaceFiles(workspace, { query: "auth" }, controller.signal)).toMatchObject({
			status: "failed",
			error: { code: "OPERATION_ABORTED" },
		});

		const host = track(new FileToolsHost());
		const tool = track(new FindTool());
		const opened = track(expectSuccess(await host.open({ cwd: workspace, sessionId: "disposed-find" })));
		tool.dispose();
		tool.dispose();
		expect(await tool.execute({ query: "auth" }, {
			filesystem: opened.filesystem,
			operation: opened.context,
			limits: opened.limits,
		})).toMatchObject({
			status: "failed",
			error: { code: "OPERATION_ABORTED" },
		});
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
		const streaming = createLimitedFindRanker(plan, 7);
		for (const entry of entries) streaming.add(entry);
		expect(limited).toEqual({
			ranked: complete.slice(0, 7),
			totalMatches: complete.length,
		});
		expect(streaming.result()).toEqual(limited);
	});
});

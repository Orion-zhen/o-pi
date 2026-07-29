import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FindTool } from "../../src/file-tools/find/command.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { isFailed } from "../../src/file-tools/shared/result.js";
import { findWorkspaceFiles } from "../helpers/find-tool.js";
import { countTextTokensSync } from "../../src/token-counter.js";
import type { ToolOutcome } from "../../src/file-tools/shared/result.js";
import type { FindMatch, FindSuccess } from "../../src/file-tools/find/types.js";
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
	await writeFile(
		configPath,
		[
			"{",
			'  "blocked_path": [".git/"],',
			'  "ignored_path": [],',
			'  "limits": { "find_result_limit": 50 },',
			'  "ignore": { "builtin_profile": "none", "gitignore": false }',
			"}",
		].join("\n"),
	);
	process.env.PI_FILE_TOOLS_CONFIG = configPath;
});

function expectFindSuccess(result: ToolOutcome<FindSuccess>): FindSuccess {
	if ("status" in result) throw new Error(`find failed: ${result.error.code}: ${result.error.message}`);
	return result;
}

function paths(matches: FindMatch[]): string[] {
	return matches.map((match) => match.path);
}

async function writeFixture(filePath: string): Promise<void> {
	const absolutePath = path.join(workspace, ...filePath.split("/"));
	await mkdir(path.dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, "");
}

describe("find", () => {
	it("路径发现统一委托 filesystem discovery，成功 glob 不重复预检静态前缀", async () => {
		await writeFixture("src/example.ts");
		const host = new FileToolsHost();
		const tool = new FindTool();
		const opened = await host.open({ cwd: workspace, sessionId: "find-discovery" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		const calls: unknown[] = [];
		const resolveExisting = vi.spyOn(opened.filesystem.paths, "resolveExisting");
		const filesystem = {
			...opened.filesystem,
			discovery: {
				async discover(root, options, operation) {
					calls.push(options);
					return await opened.filesystem.discovery.discover(root, options, operation);
				},
			},
			traversal: {
				async walk() { throw new Error("find must not call traversal directly"); },
			},
		} satisfies typeof opened.filesystem;
		try {
			const result = await tool.execute({ query: "src/**/*.ts" }, {
				filesystem,
				operation: opened.context,
				limits: opened.limits,
			});
			expectFindSuccess(result);
			expect(calls).toEqual([{
				intent: "search",
				explicitRoot: true,
				maxDepth: opened.limits.find_max_depth,
				glob: "src/**/*.ts",
			}]);
			expect(resolveExisting.mock.calls.map(([input]) => input)).not.toContain("src");
		} finally {
			tool.dispose();
			opened.dispose();
			host.dispose();
		}
	});

	it("query 自动识别 glob，并默认从 workspace root 递归匹配 basename", async () => {
		await writeFixture("src/nested/a.ts");
		await writeFixture("root.ts");
		await writeFixture("note.txt");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "*.ts" }));
		expect(result.details).toMatchObject({
			query: "*.ts",
			path: ".",
			strategy: "glob",
			totalMatches: 2,
			returnedMatches: 2,
			depthLimited: false,
			resultLimited: false,
			outputTruncated: false,
		});
		expect(paths(result.details.matches)).toEqual(["root.ts", "src/nested/a.ts"]);
	});

	it("校验空值、NUL 和越界 query，但允许 workspace 外搜索路径", async () => {
		expect(await findWorkspaceFiles(workspace, { query: "" })).toMatchObject({ status: "failed", error: { code: "INVALID_PATH" } });
		expect(await findWorkspaceFiles(workspace, { query: "a\0b" })).toMatchObject({ status: "failed", error: { code: "INVALID_PATH" } });
		expect(await findWorkspaceFiles(workspace, { query: path.resolve("outside", "a") })).toMatchObject({ status: "failed", error: { code: "INVALID_PATH" } });
		expect(await findWorkspaceFiles(workspace, { query: "../a" })).toMatchObject({ status: "failed", error: { code: "INVALID_PATH" } });
		expect(await findWorkspaceFiles(workspace, { path: [""], query: "a" })).toMatchObject({ status: "failed", error: { code: "INVALID_PATH" } });
		for (const query of [path.resolve("outside", "*.ts"), ".." + path.sep + "*.ts", path.join("src", "..", "..", "*.ts")]) {
			expect(await findWorkspaceFiles(workspace, { query })).toMatchObject({ status: "failed", error: { code: "INVALID_PATH" } });
		}
		await writeFile(path.join(outside, "external.ts"), "");
		const external = expectFindSuccess(await findWorkspaceFiles(workspace, { path: [outside], query: "external.ts" }));
		expect(external.details).toMatchObject({
			path: path.normalize(outside),
			strategy: "exact",
			matches: [{ path: path.join(outside, "external.ts").replace(/\\/gu, "/"), kind: "file" }],
		});
	});

	it("workspace 内绝对 path/query 会按 workspace-relative path 解析", async () => {
		await writeFixture("src/auth/service.ts");
		await writeFixture("src/auth/session.ts");

		const absoluteQuery = expectFindSuccess(await findWorkspaceFiles(workspace, { query: path.join(workspace, "src", "auth", "service.ts") }));
		expect(absoluteQuery.details).toMatchObject({
			query: "src/auth/service.ts",
			path: ".",
			strategy: "exact",
			matches: [{ path: "src/auth/service.ts", kind: "file" }],
		});

		const absoluteRoot = expectFindSuccess(await findWorkspaceFiles(workspace, { path: [path.join(workspace, "src", "auth")], query: "session.ts" }));
		expect(absoluteRoot.details).toMatchObject({
			query: "session.ts",
			path: "src/auth",
			strategy: "exact",
			matches: [{ path: "src/auth/session.ts", kind: "file" }],
		});

		const absoluteQueryUnderRoot = expectFindSuccess(
			await findWorkspaceFiles(workspace, { path: ["src"], query: path.join(workspace, "src", "auth", "service.ts") }),
		);
		expect(absoluteQueryUnderRoot.details).toMatchObject({
			query: "auth/service.ts",
			path: "src",
			strategy: "exact",
			matches: [{ path: "src/auth/service.ts", kind: "file" }],
		});

		const absoluteGlob = expectFindSuccess(await findWorkspaceFiles(workspace, { query: path.join(workspace, "src", "auth", "*.ts") }));
		expect(absoluteGlob.details).toMatchObject({
			query: "src/auth/*.ts",
			strategy: "glob",
			matches: [
				{ path: "src/auth/service.ts", kind: "file" },
				{ path: "src/auth/session.ts", kind: "file" },
			],
		});
	});

	it("精确文件和目录路径直接返回，且目录带尾随 slash", async () => {
		await mkdir(path.join(workspace, "src", "auth"), { recursive: true });
		await writeFile(path.join(workspace, "src", "auth", "service.ts"), "");
		for (let index = 0; index < 20; index += 1) await writeFixture(`many/file-${index}.ts`);

		const file = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "src/auth/service.ts" }));
		expect(file.details.strategy).toBe("exact");
		expect(file.content).toContain("src/auth/service.ts");

		const directory = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "src/auth" }));
		expect(directory.details.matches).toEqual([{ path: "src/auth", kind: "directory" }]);
		expect(directory.content).toContain("src/auth/");
	});

	it("query 推断 glob，但精确路径优先且普通括号仍按路径名称处理", async () => {
		await writeFixture("src/a.py");
		await writeFixture("root.py");
		await writeFixture("foo(bar)");
		await writeFixture("fooXbar");

		const glob = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "*.py" }));
		expect(glob.details.strategy).toBe("glob");
		expect(paths(glob.details.matches)).toEqual(["root.py", "src/a.py"]);
		const exact = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "foo(bar)" }));
		expect(exact.details.strategy).toBe("exact");
		expect(paths(exact.details.matches)).toEqual(["foo(bar)"]);
	});

	it("glob 过滤文件和目录，且 basename 递归模式与 scoped path pattern 等价", async () => {
		await writeFixture("src/a.ts");
		await writeFixture("src/b.tsx");
		await writeFixture("src/deep/c.ts");
		await writeFixture("src/deep/d.js");
		await mkdir(path.join(workspace, "packages", "api"), { recursive: true });
		await mkdir(path.join(workspace, "packages", "web"), { recursive: true });
		await mkdir(path.join(workspace, "db", "migrations"), { recursive: true });

		const rootGlob = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "src/**/*.ts" }));
		const scopedGlob = expectFindSuccess(await findWorkspaceFiles(workspace, { path: ["src"], query: "*.ts" }));
		expect(paths(rootGlob.details.matches)).toEqual(paths(scopedGlob.details.matches));
		expect(paths(rootGlob.details.matches)).toEqual(["src/a.ts", "src/deep/c.ts"]);

		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "packages/*/" })).details.matches)).toEqual([
			"packages/api",
			"packages/web",
		]);
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "**/migrations" })).details.matches)).toEqual([
			"db/migrations",
		]);
	});

	it("按 basename、stem、segment、path fragment 和多词 token 定位路径", async () => {
		await writeFixture("src/file-tools/find-tool.ts");
		await writeFixture("src/file-tools/config.ts");
		await writeFixture("tests/websearch-renderer.test.ts");
		await mkdir(path.join(workspace, "src", "migrations"), { recursive: true });

		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "config.ts" })).details.matches)[0]).toBe("src/file-tools/config.ts");
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "find-tool" })).details.matches)[0]).toBe("src/file-tools/find-tool.ts");
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "migrations" })).details.matches)[0]).toBe("src/migrations");
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "web search renderer test" })).details.matches)[0]).toBe(
			"tests/websearch-renderer.test.ts",
		);
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "file tools config" })).details.matches)[0]).toBe(
			"src/file-tools/config.ts",
		);
	});

	it("支持 camelCase、snake_case、kebab-case 和 smart case", async () => {
		await writeFixture("src/AuthService.test.ts");
		await writeFixture("src/auth_service.ts");
		await writeFixture("src/auth-service.ts");
		await writeFixture("src/authservice.ts");

		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "auth service" })).details.matches).slice(0, 3)).toEqual([
			"src/auth-service.ts",
			"src/auth_service.ts",
			"src/authservice.ts",
		]);
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "AuthService" })).details.matches)[0]).toBe(
			"src/AuthService.test.ts",
		);
	});

	it("精确 basename 和目录 basename 排在 fuzzy 或普通 path substring 前面", async () => {
		await writeFixture("src/deep/permission-helper.ts");
		await writeFixture("docs/permission.md");
		await writeFixture("permission.ts");
		await mkdir(path.join(workspace, "src", "auth"), { recursive: true });
		await writeFixture("src/not-auth-service.ts");

		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "permission.ts" })).details.matches)[0]).toBe("permission.ts");
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "auth" })).details.matches)[0]).toBe("src/auth");
	});

	it("多词查询严格阶段无结果后才放宽，并提供 typo 建议", async () => {
		await writeFixture("src/auth/service.ts");
		await writeFixture("src/auth/services.ts");
		await writeFixture("src/billing/service.ts");

		const strict = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "auth service" }));
		expect(paths(strict.details.matches).slice(0, 2)).toEqual(["src/auth/service.ts", "src/auth/services.ts"]);

		const typo = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "auth servce" }));
		expect(typo.content).toContain("<nearby nonmatch>");
		expect(typo.content).toContain("src/auth/service.ts [name similarity]");
		expect(paths(typo.details.nearby ?? [])).toContain("src/auth/service.ts");
	});

	it("查询包含 test/spec/fixture/mock 时提升测试路径", async () => {
		await writeFixture("src/auth/service.ts");
		await writeFixture("tests/auth/service.test.ts");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "auth service test" }));
		expect(paths(result.details.matches)[0]).toBe("tests/auth/service.test.ts");
	});

	it("未声明测试意图时实现文件排在同名测试文件前", async () => {
		await writeFixture("src/file-tools/shared/ranking/evidence.ts");
		await writeFixture("tests/file-tools/ranking-evidence.test.ts");
		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "ranking evidence" }));
		expect(paths(result.details.matches).slice(0, 2)).toEqual([
			"src/file-tools/shared/ranking/evidence.ts",
			"tests/file-tools/ranking-evidence.test.ts",
		]);
	});

	it("排序稳定，renderer 的 Top matches 保留已选相关性顺序", async () => {
		for (const directory of ["a", "b", "c"]) {
			for (let index = 0; index < 30; index += 1) await writeFixture(`${directory}/file-${String(index).padStart(2, "0")}.ts`);
		}

		const first = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "**/*.ts" }));
		const second = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "**/*.ts" }));
		expect(first).toEqual(second);
		expect(first.details.totalMatches).toBe(90);
		expect(first.details.returnedMatches).toBe(50);
		expect(first.details).toMatchObject({ depthLimited: false, resultLimited: true, outputTruncated: false });
		expect(first.content).toContain("top:");
		expect(first.content).toContain("other:");
		const topMatches = first.content.split("other:")[0] ?? "";
		expect(topMatches).toContain("a/");
		expect(topMatches).not.toContain("b/");
		expect(topMatches).not.toContain("c/");
		expect(topMatches.indexOf("a/file-00.ts")).toBeLessThan(topMatches.indexOf("a/file-01.ts"));
	});

	it("输出遵守 token budget 和结果限制，遍历只按路径深度限制而不按条目数截断", async () => {
		const configPath = path.join(outside, "find-limits.jsonc");
		await writeFile(
			configPath,
			[
				"{",
				'  "ignore": { "builtin_profile": "none", "gitignore": false },',
				'  "limits": {',
				'    "find_output_token_budget": 32,',
				'    "find_result_limit": 3,',
				'    "find_max_depth": 2',
				"  }",
				"}",
			].join("\n"),
		);
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		for (let index = 0; index < 20; index += 1) await writeFixture(`many/file-${String(index).padStart(2, "0")}.ts`);
		await writeFixture("many/deep/hidden.ts");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "**/*.ts" }));
		expect(countTextTokensSync(result.content).tokens).toBeLessThanOrEqual(32);
		expect(result.details.totalMatches).toBe(20);
		expect(result.details.returnedMatches).toBeLessThanOrEqual(3);
		expect(result.details.depthLimited).toBe(true);
		expect(paths(result.details.matches)).not.toContain("many/deep/hidden.ts");
		expect(result.content.split("\n")[0]).toContain("truncated=depth");
	});

	it("遵守 .piignore 的 search、traverse、反向 include 和 prune 语义", async () => {
		await mkdir(path.join(workspace, "ignored"), { recursive: true });
		await mkdir(path.join(workspace, "pruned"), { recursive: true });
		await writeFile(path.join(workspace, ".piignore"), ["ignored/*", "!ignored/keep.ts", "pruned/"].join("\n"));
		await writeFile(path.join(workspace, "ignored", "drop.ts"), "");
		await writeFile(path.join(workspace, "ignored", "keep.ts"), "");
		await writeFile(path.join(workspace, "pruned", "hidden.ts"), "");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "*.ts" }));
		expect(paths(result.details.matches)).toEqual(["ignored/keep.ts"]);
		expect(result.details.ignoredCount).toBeGreaterThanOrEqual(2);
	});

	it("显式 find 允许命中 soft ignored 文件和目录内容", async () => {
		await mkdir(path.join(workspace, "ignored-dir"), { recursive: true });
		await writeFile(path.join(workspace, ".piignore"), "ignored.ts\nignored-dir/\n");
		await writeFile(path.join(workspace, "ignored.ts"), "");
		await writeFile(path.join(workspace, "ignored-dir", "secret.ts"), "");

		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "*.ts" })).details.matches)).toEqual([]);
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "ignored.ts" })).details.matches)).toEqual(["ignored.ts"]);
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { path: ["ignored-dir"], query: "*.ts" })).details.matches)).toEqual([
			"ignored-dir/secret.ts",
		]);
		expect(paths(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "ignored-dir/**/*.ts" })).details.matches)).toEqual([
			"ignored-dir/secret.ts",
		]);
	});

	it("blocked path 不出现在结果、统计或建议中，dotfile 正常参与搜索", async () => {
		await mkdir(path.join(workspace, ".github"), { recursive: true });
		await mkdir(path.join(workspace, ".git"), { recursive: true });
		await writeFile(path.join(workspace, ".env.example"), "");
		await writeFile(path.join(workspace, ".github", "workflow.yml"), "");
		await writeFile(path.join(workspace, ".git", "config"), "");

		const env = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "env" }));
		expect(paths(env.details.matches)).toContain(".env.example");
		const git = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "git" }));
		expect(paths(git.details.matches)).toContain(".github");
		expect(paths(git.details.matches)).not.toContain(".git/config");
		expect(await findWorkspaceFiles(workspace, { path: [".git"], query: "*" })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH" },
		});
	});

	it("blocked_path 对 search root 的 realpath 生效", async () => {
		const protectedDir = path.join(outside, "protected");
		const configPath = path.join(outside, "blocked-realpath.jsonc");
		await mkdir(protectedDir);
		await writeFile(path.join(protectedDir, "secret.ts"), "");
		await writeFile(
			configPath,
			JSON.stringify({ blocked_path: [`${protectedDir}/`], ignore: { builtin_profile: "none", gitignore: false } }),
		);
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		try {
			await symlink(protectedDir, path.join(workspace, "protected-link"), "dir");
		} catch {
			return;
		}
		expect(await findWorkspaceFiles(workspace, { path: ["protected-link"], query: "*.ts" })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH" },
		});
	});

	it("不返回文件 symlink，也不进入目录 symlink", async () => {
		await mkdir(path.join(workspace, "real-dir"));
		await writeFile(path.join(workspace, "real-dir", "real.ts"), "");
		await writeFile(path.join(workspace, "target.ts"), "");
		try {
			await symlink(path.join(workspace, "target.ts"), path.join(workspace, "link.ts"), "file");
			await symlink(path.join(workspace, "real-dir"), path.join(workspace, "link-dir"), "dir");
		} catch {
			return;
		}

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "*.ts" }));
		expect(paths(result.details.matches)).toEqual(["real-dir/real.ts", "target.ts"]);
		expect(paths(result.details.matches)).not.toContain("link.ts");
		expect(paths(result.details.matches)).not.toContain("link-dir/real.ts");
		expect(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "link-dir" })).details.totalMatches).toBe(0);
	});

	it("多个 scope 按 union 合并、去重并保留 scope 顺序", async () => {
		await writeFixture("src/shared.ts");
		await writeFixture("src/only-src.ts");
		await writeFixture("tests/shared.ts");
		await writeFixture("tests/only-tests.ts");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "*.ts", path: ["src", "tests"] }));
		expect(result.details.paths).toEqual(["src", "tests"]);
		expect(paths(result.details.matches)).toEqual([
			"src/only-src.ts",
			"tests/only-tests.ts",
			"src/shared.ts",
			"tests/shared.ts",
		]);
	});

	it("嵌套、重复及同一目录的绝对 scope 只保留外层扫描结果", async () => {
		await writeFixture("src/lib/inside.ts");
		await writeFixture("src/outside.ts");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "*.ts", path: ["src/lib", "src", path.join(workspace, "src"), "src"] }));
		expect(result.details.paths).toEqual(["src"]);
		expect(paths(result.details.matches)).toEqual(["src/lib/inside.ts", "src/outside.ts"]);
	});

	it("一个 scope 失败时保留成功结果并记录 scope_errors", async () => {
		await writeFixture("src/available.ts");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "*.ts", path: ["src", "missing"] }));
		expect(paths(result.details.matches)).toEqual(["src/available.ts"]);
		expect(result.content).toContain("partial; scope_errors=missing:PATH_NOT_FOUND");
		expect(result.details.scope_errors).toMatchObject([{ path: "missing", error: { code: "PATH_NOT_FOUND" } }]);
	});

	it("所有 scope 失败时返回结构化失败结果", async () => {
		const result = await findWorkspaceFiles(workspace, { query: "*.ts", path: ["missing", "also-missing"] });
		expect(result).toMatchObject({
			status: "failed",
			error: { code: "PATH_NOT_FOUND", details: { scope_errors: expect.any(Array) } },
		});
	});

	it("多个 scope 共享全局结果限制", async () => {
		const configPath = process.env.PI_FILE_TOOLS_CONFIG;
		if (configPath === undefined) throw new Error("missing test config path");
		await writeFile(configPath, JSON.stringify({ limits: { find_result_limit: 3 }, ignore: { builtin_profile: "none", gitignore: false } }));
		await writeFixture("src/a.ts");
		await writeFixture("src/b.ts");
		await writeFixture("tests/c.ts");
		await writeFixture("tests/d.ts");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "*.ts", path: ["src", "tests"] }));
		expect(result.details.totalMatches).toBe(4);
		expect(result.details.returnedMatches).toBe(3);
		expect(result.details.resultLimited).toBe(true);
	});

	it("零结果、missing prefix nearby 和 AbortSignal", async () => {
		await mkdir(path.join(workspace, "src"));
		await writeFile(path.join(workspace, "src", "a.ts"), "");

		const none = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "no-such-file" }));
		expect(none.content).toBe("none\nignored=0; skipped=0\nnext: broaden query or path");
		expect(none.details.nearby).toBeUndefined();

		const missing = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "srcs/**/*.ts" }));
		expect(missing.content).toContain("missing prefix: srcs/");
		expect(missing.content).toContain("near dir: src/");

		const controller = new AbortController();
		controller.abort();
		expect(await findWorkspaceFiles(workspace, { query: "*" }, controller.signal)).toMatchObject({
			status: "failed",
			error: { code: "OPERATION_ABORTED" },
		});
	});
});

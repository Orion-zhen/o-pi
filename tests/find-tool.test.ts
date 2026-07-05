import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findWorkspaceFiles } from "../src/file-tools/find-tool.js";
import { countTextTokensSync } from "../src/token-counter.js";
import type { FindMatch, FindSuccess, ToolOutcome } from "../src/file-tools/types.js";

let workspace: string;
let outside: string;
let previousConfigPath: string | undefined;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "o-pi-find-"));
	outside = await mkdtemp(path.join(os.tmpdir(), "o-pi-find-outside-"));
	previousConfigPath = process.env.PI_FILE_TOOLS_CONFIG;
	const configPath = path.join(outside, "file-tools.jsonc");
	await writeFile(
		configPath,
		[
			"{",
			'  "version": 1,',
			'  "blocked_path": [".git/"],',
			'  "ignored_path": [],',
			'  "ignore": { "builtin_profile": "none", "gitignore": false }',
			"}",
		].join("\n"),
	);
	process.env.PI_FILE_TOOLS_CONFIG = configPath;
});

afterEach(async () => {
	if (previousConfigPath === undefined) delete process.env.PI_FILE_TOOLS_CONFIG;
	else process.env.PI_FILE_TOOLS_CONFIG = previousConfigPath;
	await rm(workspace, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
});

function expectFindSuccess(result: ToolOutcome<FindSuccess>): FindSuccess {
	if ("status" in result) throw new Error(`find failed: ${result.error.code}: ${result.error.message}`);
	return result;
}

function paths(matches: FindMatch[]): string[] {
	return matches.map((match) => match.path);
}

async function writeFixture(filePath: string): Promise<void> {
	await mkdir(path.dirname(path.join(workspace, filePath)), { recursive: true });
	await writeFile(path.join(workspace, filePath), "");
}

describe("find", () => {
	it("使用新 query/path schema，默认从 workspace root 搜索并拒绝旧 pattern", async () => {
		await writeFixture("src/nested/a.ts");
		await writeFixture("root.ts");
		await writeFixture("note.txt");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "**/*.ts" }));
		expect(result.details).toMatchObject({
			query: "**/*.ts",
			path: ".",
			strategy: "glob",
			totalMatches: 2,
			returnedMatches: 2,
			truncated: false,
		});
		expect(paths(result.details.matches)).toEqual(["root.ts", "src/nested/a.ts"]);
		expect(await findWorkspaceFiles(workspace, { pattern: "**/*.ts" } as never)).toMatchObject({
			status: "failed",
			error: { code: "INVALID_PATH" },
		});
	});

	it("校验空值、NUL、workspace 外绝对路径和越界路径", async () => {
		expect(await findWorkspaceFiles(workspace, { query: "" })).toMatchObject({ status: "failed", error: { code: "INVALID_PATH" } });
		expect(await findWorkspaceFiles(workspace, { query: "a\0b" })).toMatchObject({ status: "failed", error: { code: "INVALID_PATH" } });
		expect(await findWorkspaceFiles(workspace, { query: "/tmp/a" })).toMatchObject({ status: "failed", error: { code: "INVALID_PATH" } });
		expect(await findWorkspaceFiles(workspace, { query: "../a" })).toMatchObject({ status: "failed", error: { code: "INVALID_PATH" } });
		expect(await findWorkspaceFiles(workspace, { path: "", query: "a" })).toMatchObject({ status: "failed", error: { code: "INVALID_PATH" } });
		expect(await findWorkspaceFiles(workspace, { path: path.relative(workspace, outside), query: "a" })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_PATH" },
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

		const absoluteRoot = expectFindSuccess(await findWorkspaceFiles(workspace, { path: path.join(workspace, "src", "auth"), query: "session.ts" }));
		expect(absoluteRoot.details).toMatchObject({
			query: "session.ts",
			path: "src/auth",
			strategy: "exact",
			matches: [{ path: "src/auth/session.ts", kind: "file" }],
		});

		const absoluteQueryUnderRoot = expectFindSuccess(
			await findWorkspaceFiles(workspace, { path: "src", query: path.join(workspace, "src", "auth", "service.ts") }),
		);
		expect(absoluteQueryUnderRoot.details).toMatchObject({
			query: "auth/service.ts",
			path: "src",
			strategy: "exact",
			matches: [{ path: "src/auth/service.ts", kind: "file" }],
		});
	});

	it("精确文件和目录路径直接返回，且目录带尾随 slash", async () => {
		await mkdir(path.join(workspace, "src", "auth"), { recursive: true });
		await writeFile(path.join(workspace, "src", "auth", "service.ts"), "");
		for (let index = 0; index < 20; index += 1) await writeFixture(`many/file-${index}.ts`);

		const file = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "src/auth/service.ts" }));
		expect(file.details.strategy).toBe("exact");
		expect(file.details.scannedEntries).toBe(0);
		expect(file.content).toContain("src/auth/service.ts");

		const directory = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "src/auth" }));
		expect(directory.details.matches).toEqual([{ path: "src/auth", kind: "directory" }]);
		expect(directory.content).toContain("src/auth/");
	});

	it("精确路径优先于 glob 判断，普通括号不会自动作为 glob", async () => {
		await writeFixture("foo(bar)");
		await writeFixture("fooXbar");

		const exact = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "foo(bar)" }));
		expect(exact.details.strategy).toBe("exact");
		expect(paths(exact.details.matches)).toEqual(["foo(bar)"]);
	});

	it("glob 支持文件和目录，且 src/**/*.ts 与 path=src query=**/*.ts 等价", async () => {
		await writeFixture("src/a.ts");
		await writeFixture("src/b.tsx");
		await writeFixture("src/deep/c.ts");
		await writeFixture("src/deep/d.js");
		await mkdir(path.join(workspace, "packages", "api"), { recursive: true });
		await mkdir(path.join(workspace, "packages", "web"), { recursive: true });
		await mkdir(path.join(workspace, "db", "migrations"), { recursive: true });

		const rootGlob = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "src/**/*.ts" }));
		const scopedGlob = expectFindSuccess(await findWorkspaceFiles(workspace, { path: "src", query: "**/*.ts" }));
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
			"src/AuthService.test.ts",
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
		expect(typo.content).toContain("Nearby:");
		expect(paths(typo.details.suggestions ?? [])).toContain("src/auth/service.ts");
	});

	it("查询包含 test/spec/fixture/mock 时提升测试路径", async () => {
		await writeFixture("src/auth/service.ts");
		await writeFixture("tests/auth/service.test.ts");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "auth service test" }));
		expect(paths(result.details.matches)[0]).toBe("tests/auth/service.test.ts");
	});

	it("排序稳定，renderer 保留相关性顺序且大结果覆盖多个顶层目录", async () => {
		for (const directory of ["a", "b", "c"]) {
			for (let index = 0; index < 30; index += 1) await writeFixture(`${directory}/file-${String(index).padStart(2, "0")}.ts`);
		}

		const first = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "**/*.ts" }));
		const second = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "**/*.ts" }));
		expect(first).toEqual(second);
		expect(first.details.totalMatches).toBe(90);
		expect(first.details.returnedMatches).toBe(50);
		expect(first.content).toContain("Top matches:");
		expect(first.content).toContain("Other matches:");
		expect(first.content).toContain("a/");
		expect(first.content).toContain("b/");
		expect(first.content).toContain("c/");
	});

	it("输出遵守 token budget，find_result_limit 和 find_max_entries_scanned 生效", async () => {
		const configPath = path.join(outside, "find-limits.jsonc");
		await writeFile(
			configPath,
			[
				"{",
				'  "version": 1,',
				'  "ignore": { "builtin_profile": "none", "gitignore": false },',
				'  "limits": {',
				'    "find_output_token_budget": 12,',
				'    "find_result_limit": 3,',
				'    "find_max_entries_scanned": 5',
				"  }",
				"}",
			].join("\n"),
		);
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		for (let index = 0; index < 20; index += 1) await writeFixture(`many/file-${String(index).padStart(2, "0")}.ts`);

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "**/*.ts" }));
		expect(countTextTokensSync(result.content).tokens).toBeLessThanOrEqual(12);
		expect(result.details.returnedMatches).toBeLessThanOrEqual(3);
		expect(result.details.scannedEntries).toBe(5);
		expect(result.details.truncated).toBe(true);
	});

	it("遵守 .piignore 的 search、traverse、反向 include 和 prune 语义", async () => {
		await mkdir(path.join(workspace, "ignored"), { recursive: true });
		await mkdir(path.join(workspace, "pruned"), { recursive: true });
		await writeFile(path.join(workspace, ".piignore"), ["ignored/*", "!ignored/keep.ts", "pruned/"].join("\n"));
		await writeFile(path.join(workspace, "ignored", "drop.ts"), "");
		await writeFile(path.join(workspace, "ignored", "keep.ts"), "");
		await writeFile(path.join(workspace, "pruned", "hidden.ts"), "");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "**/*.ts" }));
		expect(paths(result.details.matches)).toEqual(["ignored/keep.ts"]);
		expect(result.details.ignoredCount).toBeGreaterThanOrEqual(2);
	});

	it("blocked path 不出现在结果、统计或建议中，dotfile 正常参与搜索", async () => {
		await mkdir(path.join(workspace, ".github"), { recursive: true });
		await mkdir(path.join(workspace, ".git"), { recursive: true });
		await writeFile(path.join(workspace, ".env.example"), "");
		await writeFile(path.join(workspace, ".github", "workflow.yml"), "");
		await writeFile(path.join(workspace, ".git", "config"), "");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "**/*" }));
		expect(paths(result.details.matches)).toContain(".env.example");
		expect(paths(result.details.matches)).toContain(".github");
		expect(paths(result.details.matches)).not.toContain(".git/config");
		expect(result.details.scannedEntries).toBe(3);
		expect(await findWorkspaceFiles(workspace, { path: ".git", query: "**/*" })).toMatchObject({
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

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "**/*.ts" }));
		expect(paths(result.details.matches)).toEqual(["target.ts", "real-dir/real.ts"]);
		expect(paths(result.details.matches)).not.toContain("link.ts");
		expect(paths(result.details.matches)).not.toContain("link-dir/real.ts");
		expect(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "link-dir" })).details.totalMatches).toBe(0);
	});

	it("零结果、missing prefix nearby 和 AbortSignal", async () => {
		await mkdir(path.join(workspace, "src"));
		await writeFile(path.join(workspace, "src", "a.ts"), "");

		expect(expectFindSuccess(await findWorkspaceFiles(workspace, { query: "no-such-file" })).content).toContain("No matches");

		const missing = expectFindSuccess(await findWorkspaceFiles(workspace, { query: "srcs/**/*.ts" }));
		expect(missing.content).toContain("Missing prefix: srcs/");
		expect(missing.content).toContain("Nearby directory: src/");

		const controller = new AbortController();
		controller.abort();
		expect(await findWorkspaceFiles(workspace, { query: "**/*" }, controller.signal)).toMatchObject({
			status: "failed",
			error: { code: "OPERATION_ABORTED" },
		});
	});
});

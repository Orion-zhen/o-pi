import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { WorkspaceFileSystem } from "../../src/filesystem/contracts/workspace.js";
import { formatCompactGrepResult, GrepTool } from "../../src/file-tools/grep/command.js";
import { grepWorkspaceFiles } from "../helpers/grep-tool.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { isFailed } from "../../src/file-tools/shared/result.js";
import type { GrepSuccess } from "../../src/file-tools/grep/types.js";
import { createGrepTestContext, expectGrepSuccess, firstRegion, assertStrictMatches, writeConfig } from "./grep-fixtures.js";

const testContext = createGrepTestContext();

describe("grep local search", () => {
	it("path 默认 workspace，并按 symbol 返回完整函数", async () => {
		await writeFile(path.join(testContext.workspace, "auth.ts"), "export function login() {\n  return issueToken();\n}\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "login" }));
		expect(result).toMatchObject({ status: "success", path: ".", match: "auto" });
		expect(firstRegion(result)).toMatchObject({ path: "auth.ts", symbol: "login", detail: "body" });
		expect(firstRegion(result).content).toContain("export function login()");
		const text = formatCompactGrepResult(result);
		expect(text).toContain("<grep>");
		expect(text).not.toContain('query="login"');
		expect(text).toContain("</grep>");
		expect(text).not.toContain("tokens");
	});

	it("workspace 内绝对 path 会按 workspace-relative path 检索", async () => {
		await mkdir(path.join(testContext.workspace, "src"));
		await writeFile(path.join(testContext.workspace, "src", "auth.ts"), "export function login() { return true; }\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: [path.join(testContext.workspace, "src")], query: "login" }));
		expect(result).toMatchObject({ status: "success", path: "src" });
		expect(firstRegion(result)).toMatchObject({ path: "src/auth.ts", symbol: "login" });
	});

	it("workspace 外绝对 path 可以检索", async () => {
		await writeFile(path.join(testContext.outside, "external.ts"), "export function externalNeedle() { return true; }\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: [testContext.outside], query: "externalNeedle" }));
		expect(result).toMatchObject({ status: "success", path: path.normalize(testContext.outside) });
		expect(firstRegion(result)).toMatchObject({ path: path.join(testContext.outside, "external.ts").replaceAll("\\", "/"), symbol: "externalNeedle" });
	});

	it("无显式关系意图时定义进入 main，caller/callee 保持 related", async () => {
		await writeFile(path.join(testContext.workspace, "service.ts"), "export function login() {\n  return issueToken();\n}\nfunction issueToken() { return 't'; }\n");
		await writeFile(path.join(testContext.workspace, "route.ts"), "import { login } from './service';\nexport function handle() {\n  return login();\n}\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "login" }));
		expect(firstRegion(result)).toMatchObject({ path: "service.ts", symbol: "login" });
		expect(result.regions.some((region) => region.reasons.includes("caller") || region.reasons.includes("callee"))).toBe(false);
		expect(result.related).toEqual(expect.arrayContaining([
			expect.objectContaining({ symbol: "handle", relations: ["caller"] }),
			expect.objectContaining({ symbol: "issueToken", relations: ["callee"] }),
		]));
		expect(formatCompactGrepResult(result)).not.toContain("calls: issueToken");
	});

	it("支持 qualified symbol", async () => {
		await writeFile(path.join(testContext.workspace, "auth.ts"), "export class AuthService {\n  async login(credentials: Credentials): Promise<Session> {\n    return issueToken();\n  }\n}\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "AuthService.login" }));
		expect(firstRegion(result)).toMatchObject({ symbol: "AuthService.login" });
		expect(firstRegion(result).reasons).toContain("exact qualified symbol");
	});

	it("camelCase、snake_case、路径和 docstring 能被自然语言召回", async () => {
		await mkdir(path.join(testContext.workspace, "src"));
		await writeFile(path.join(testContext.workspace, "src", "session_token.py"), 'def issue_session_token(user):\n    """create authentication flow token"""\n    return user.id\n');
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "authentication flow session token" }));
		expect(firstRegion(result)).toMatchObject({ path: "src/session_token.py", symbol: "issue_session_token" });
		expect(firstRegion(result).reasons).toContain("lexical");
	});

	it("literal 区分大小写并将同一代码单元的多个真实命中聚合", async () => {
		await writeFile(path.join(testContext.workspace, "a.ts"), "export function demo() {\n  const Token = 'Token';\n  const token = 'token';\n  return Token;\n}\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Token", match: "literal" }));
		expect(result.regions).toEqual([
			expect.objectContaining({
				path: "a.ts",
				kind: "function",
				symbol: "demo",
				query_match: "verified",
				match_lines: [2, 4],
			}),
		]);
		expect(result.stats.parsed_files).toBe(1);
		await assertStrictMatches(testContext.workspace, result, "Token", "literal");
	});

	it.each([
		{
			name: "方法",
			query: "MethodNeedle",
			content: "export class Service {\n  run() {\n    return 'MethodNeedle';\n  }\n}\n",
			expected: { kind: "method", symbol: "Service.run", match_lines: [3] },
		},
		{
			name: "类声明",
			query: "ClassNeedle",
			content: "export class ClassNeedle {\n  run() { return true; }\n}\n",
			expected: { kind: "class", symbol: "ClassNeedle", match_lines: [1] },
		},
		{
			name: "变量声明",
			query: "DeclarationNeedle",
			content: "export const declaration = 'DeclarationNeedle';\n",
			expected: { kind: "declaration", symbol: "declaration", match_lines: [1] },
		},
	] as const)("strict 将命中映射到最小 enclosing $name", async ({ query, content, expected }) => {
		await writeFile(path.join(testContext.workspace, "region.ts"), content);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query, match: "literal" }));
		expect(firstRegion(result)).toMatchObject(expected);
		await assertStrictMatches(testContext.workspace, result, query, "literal");
	});

	it.each([
		["TopCommentNeedle", "// TopCommentNeedle\nexport const value = true;\n", 1],
		["ImportNeedle", "import { ImportNeedle } from './dependency';\nexport const value = true;\n", 1],
		["TopBodyNeedle", "console.log('TopBodyNeedle');\nexport const value = true;\n", 1],
	] as const)("AST 外正文 %s 安全降级为 verified 文本窗口", async (query, content, line) => {
		await writeFile(path.join(testContext.workspace, "outside.ts"), content);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query, match: "literal" }));
		expect(firstRegion(result)).toMatchObject({ kind: "text", query_match: "verified", match_lines: [line] });
		await assertStrictMatches(testContext.workspace, result, query, "literal");
	});

	it("深度范围内的合规文件不受解析文件数量限制", async () => {
		await writeFile(path.join(testContext.workspace, "a.ts"), "export function first() { return 'BudgetNeedle'; }\n");
		await writeFile(path.join(testContext.workspace, "b.ts"), "export function second() { return 'BudgetNeedle'; }\n");

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "BudgetNeedle", match: "literal" }));

		expect(result.regions).toEqual([
			expect.objectContaining({ path: "a.ts", kind: "function", symbol: "first", match_lines: [1] }),
			expect.objectContaining({ path: "b.ts", kind: "function", symbol: "second", match_lines: [1] }),
		]);
		expect(result.stats.parsed_files).toBe(2);
		expect(result.truncated_by).not.toContain("semantic_candidate_limit");
		await assertStrictMatches(testContext.workspace, result, "BudgetNeedle", "literal");
	});

	it("parse 单文件字节上限保留文本窗口并报告语义预算", async () => {
		const configPath = path.join(testContext.outside, "strict-parse-bytes.jsonc");
		await writeConfig(configPath, { grep_ast_max_file_bytes: 1024 });
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await writeFile(path.join(testContext.workspace, "large-region.ts"), `export function largeRegion() {\n  return '${"padding".repeat(180)} ParseBytesNeedle';\n}\n`);

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "ParseBytesNeedle", match: "literal" }));

		expect(firstRegion(result)).toMatchObject({ path: "large-region.ts", kind: "text", match_lines: [2] });
		expect(result.stats.parsed_files).toBe(0);
		expect(result.truncated_by).toContain("semantic_candidate_limit");
	});

	it("派生 AST cache 冷暖结果一致，修改、重命名和删除不会复用 stale range", async () => {
		const originalPath = path.join(testContext.workspace, "cache.ts");
		const renamedPath = path.join(testContext.workspace, "renamed.ts");
		await writeFile(originalPath, "export function cached() {\n  return 'CacheNeedle';\n}\n");
		const snapshot = (result: GrepSuccess) => result.regions.map(({ path: filePath, start_line, end_line, kind, symbol, match_lines }) => ({
			path: filePath,
			start_line,
			end_line,
			kind,
			symbol,
			match_lines,
		}));

		const cold = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "CacheNeedle", match: "literal" }));
		const warm = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "CacheNeedle", match: "literal" }));
		expect(snapshot(warm)).toEqual(snapshot(cold));
		expect(firstRegion(warm)).toMatchObject({ kind: "function", symbol: "cached", match_lines: [2] });

		await writeFile(originalPath, "// CacheNeedle moved outside every declaration\nexport const current = true;\n");
		const modified = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "CacheNeedle", match: "literal" }));
		expect(firstRegion(modified)).toMatchObject({ path: "cache.ts", kind: "text", match_lines: [1] });
		expect(firstRegion(modified).symbol).toBeUndefined();

		await rename(originalPath, renamedPath);
		const renamed = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "CacheNeedle", match: "literal" }));
		expect(renamed.regions.map((region) => region.path)).toEqual(["renamed.ts"]);
		await rm(renamedPath);
		const deleted = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "CacheNeedle", match: "literal" }));
		expect(deleted.regions).toEqual([]);
	});

	it("regionizer 的 live gate 不会把 scanner 旧 range 混入新正文", async () => {
		await writeFile(path.join(testContext.workspace, "race-region.ts"), "export function before() { return 'RaceNeedle'; }\n");
		const host = new FileToolsHost();
		const tool = new GrepTool();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-region-race" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		const original = opened.filesystem.content;
		let changed = false;
		const filesystem: WorkspaceFileSystem = {
			...opened.filesystem,
			content: {
				readBytes: original.readBytes.bind(original),
				async readText(file, options, context) {
					if (!changed) {
						changed = true;
						await writeFile(path.join(testContext.workspace, "race-region.ts"), "export function after() { return 'current'; }\n");
					}
					return await original.readText(file, options, context);
				},
				decodeText: original.decodeText.bind(original),
				sliceText: original.sliceText.bind(original),
				scanLines: original.scanLines.bind(original),
			},
		};
		try {
			const result = expectGrepSuccess(await tool.execute({ query: "RaceNeedle", match: "literal" }, {
				filesystem,
				operation: opened.context,
				limits: opened.limits,
			}));
			expect(result.regions).toEqual([]);
			expect(result.stats.skipped_files).toMatchObject({ changed: 1 });
		} finally {
			tool.dispose();
			opened.dispose();
			host.dispose();
		}
	});

	it("visibility fingerprint 变化后 cache 不会补回被 ignore 的文件", async () => {
		const configPath = path.join(testContext.outside, "visibility-cache.jsonc");
		await writeConfig(configPath);
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await mkdir(path.join(testContext.workspace, "hidden"));
		await writeFile(path.join(testContext.workspace, "hidden", "cached.ts"), "export function hidden() { return 'VisibilityNeedle'; }\n");
		const visible = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "VisibilityNeedle", match: "literal" }));
		expect(firstRegion(visible)).toMatchObject({ path: "hidden/cached.ts", kind: "function" });

		await writeFile(configPath, JSON.stringify({
			blocked_path: [".git/"],
			ignored_path: ["hidden/"],
			ignore: { builtin_profile: "none", gitignore: false },
		}));
		const ignored = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "VisibilityNeedle", match: "literal" }));
		expect(ignored.regions).toEqual([]);
		const explicit = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, {
			path: ["hidden/cached.ts"],
			query: "VisibilityNeedle",
			match: "literal",
		}));
		expect(firstRegion(explicit)).toMatchObject({ path: "hidden/cached.ts", kind: "function" });
	});

	it("regionizer 统一 scanner 原始 BOM offset 与 AST UTF-8 byte offset", async () => {
		await writeFile(path.join(testContext.workspace, "utf8.ts"), Buffer.concat([
			Buffer.from([0xef, 0xbb, 0xbf]),
			Buffer.from("export function utf8() { return '😀 Utf8RegionNeedle'; }\n"),
		]));
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Utf8RegionNeedle", match: "literal" }));
		expect(firstRegion(result)).toMatchObject({ kind: "function", symbol: "utf8", match_lines: [1] });
	});

	it.each([
		["CRLF", "export function newline() {\r\n  return 'RegionNewlineNeedle';\r\n}\r\n", "function"],
		["CR", "export function newline() {\r  return 'RegionNewlineNeedle';\r}\r", "text"],
	] as const)("regionizer 对 %s 保持 logical match line，不能安全解析时降级", async (_name, content, kind) => {
		await writeFile(path.join(testContext.workspace, "newline.ts"), content);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "RegionNewlineNeedle", match: "literal" }));
		expect(firstRegion(result)).toMatchObject({ kind, match_lines: [2], query_match: "verified" });
	});

	it("strict 冷暖 cache 都重新执行 inventory line scan", async () => {
		await writeFile(path.join(testContext.workspace, "warm.ts"), "export function warm() { return 'WarmNeedle'; }\n");
		const host = new FileToolsHost();
		const tool = new GrepTool();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-strict-warm" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		let scans = 0;
		let fullReads = 0;
		const original = opened.filesystem.content;
		const filesystem: WorkspaceFileSystem = {
			...opened.filesystem,
			content: {
				readBytes: original.readBytes.bind(original),
				async readText(file, options, context) {
					fullReads += 1;
					return await original.readText(file, options, context);
				},
				decodeText: original.decodeText.bind(original),
				sliceText: original.sliceText.bind(original),
				async scanLines(file, options, context) {
					scans += 1;
					return await original.scanLines(file, options, context);
				},
			},
		};
		try {
			const results: GrepSuccess[] = [];
			for (let index = 0; index < 2; index += 1) {
				results.push(expectGrepSuccess(await tool.execute({ query: "WarmNeedle", match: "literal" }, {
					filesystem,
					operation: opened.context,
					limits: opened.limits,
				})));
			}
			expect({ scans, fullReads }).toEqual({ scans: 2, fullReads: 2 });
			expect(results[1]?.regions).toEqual(results[0]?.regions);
		} finally {
			tool.dispose();
			opened.dispose();
			host.dispose();
		}
	});
});

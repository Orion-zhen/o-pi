import { mkdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { formatCompactGrepResult } from "../../src/file-tools/grep/command.js";
import { grepWorkspaceFiles } from "../helpers/grep-tool.js";
import type { GrepSuccess } from "../../src/file-tools/grep/types.js";
import {
	assertStrictMatches,
	createGrepTestContext,
	expectGrepSuccess,
	firstRegion,
	overrideContent,
	withGrepRuntime,
	writeConfig,
} from "./grep-fixtures.js";

const testContext = createGrepTestContext();

describe("grep local search", () => {
	it("结构化路径命中不会被靠前文件中的重复正文命中挤出结果窗口", async () => {
		const configPath = path.join(testContext.outside, "structured-path-ranking.jsonc");
		await writeConfig(configPath, { grep_result_limit: 6 });
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await mkdir(path.join(testContext.workspace, "aaa"), { recursive: true });
		await mkdir(path.join(testContext.workspace, "src", "file-tools", "find"), { recursive: true });
		await writeFile(path.join(testContext.workspace, "aaa", "noise.ts"), Array.from(
			{ length: 9 },
			(_, index) => `export function unrelated${index}() { return find(${index}); }`,
		).join("\n"));
		await writeFile(
			path.join(testContext.workspace, "src", "file-tools", "find", "command.ts"),
			"export function executeSearch() { return find('target'); }\n",
		);

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "find" }));

		expect(result.regions[0]).toMatchObject({
			path: "src/file-tools/find/command.ts",
			symbol: "executeSearch",
		});
		expect(result.truncated_by).toContain("result_limit");
	});

	it("path 默认 workspace，并按 symbol 返回 body-free 语法锚点", async () => {
		await writeFile(path.join(testContext.workspace, "auth.ts"), "export function login() {\n  return issueToken();\n}\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "login" }));
		expect(result).toMatchObject({ status: "success", path: "." });
		expect(firstRegion(result)).toMatchObject({ path: "auth.ts", symbol: "login", declaration: "export function login()" });
		expect(firstRegion(result)).not.toHaveProperty("content");
		const text = formatCompactGrepResult(result);
		expect(text).toContain("<grep>");
		expect(text).not.toContain('query="login"');
		expect(text).toContain("</grep>");
		expect(text).not.toContain("tokens");
	});

	it("区域展示限制均匀选择代表行且不裁剪完整 match_lines", async () => {
		const configPath = path.join(testContext.outside, "regional-display.jsonc");
		await writeConfig(configPath, { grep_regional_display_limit: 2 });
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await writeFile(path.join(testContext.workspace, "multi.ts"), [
			"export function collect() {",
			"  consume(needle);",
			"  transform(needle);",
			"  validate(needle);",
			"  return needle;",
			"}",
		].join("\n"));

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "needle" }));
		expect(firstRegion(result)).toMatchObject({
			start_line: 1,
			end_line: 6,
			match_lines: [2, 3, 4, 5],
			display_lines: [expect.objectContaining({ line: 2 }), expect.objectContaining({ line: 5 })],
		});
		const output = formatCompactGrepResult(result);
		expect(output).toContain("  2:   consume(needle);");
		expect(output).toContain("  5:   return needle;");
		expect(output).toContain("  +2 match lines");
	});

	it.each([
		{ limit: 1, shown: [2], omitted: 3 },
		{ limit: 4, shown: [2, 3, 4, 5], omitted: 0 },
	])("区域展示限制 $limit 生成固定代表行", async ({ limit, shown, omitted }) => {
		const configPath = path.join(testContext.outside, `regional-display-${limit}.jsonc`);
		await writeConfig(configPath, { grep_regional_display_limit: limit });
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await writeFile(path.join(testContext.workspace, `multi-${limit}.ts`), [
			"export function collect() {",
			"  consume(needle);",
			"  transform(needle);",
			"  validate(needle);",
			"  return needle;",
			"}",
		].join("\n"));

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "needle" }));
		expect(firstRegion(result).match_lines).toEqual([2, 3, 4, 5]);
		expect(firstRegion(result).display_lines?.map((line) => line.line)).toEqual(shown);
		const output = formatCompactGrepResult(result);
		if (omitted > 0) expect(output).toContain(`  +${omitted} match lines`);
		else expect(output).not.toContain("match lines");
	});

	it("单个代码命中直接使用行号格式", async () => {
		await writeFile(path.join(testContext.workspace, "single.ts"), "export function run() {\n  return needle;\n}\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "needle" }));
		expect(formatCompactGrepResult(result)).toContain("  2:   return needle;");
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

	it("普通 query 不生成关系候选", async () => {
		await writeFile(path.join(testContext.workspace, "service.ts"), "export function login() {\n  return issueToken();\n}\nfunction issueToken() { return 't'; }\n");
		await writeFile(path.join(testContext.workspace, "route.ts"), "import { login } from './service';\nexport function handle() {\n  return login();\n}\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "login" }));
		expect(firstRegion(result)).toMatchObject({ path: "service.ts", symbol: "login" });
		expect(result.regions.every((region) => region.query_match === "verified")).toBe(true);
		expect(formatCompactGrepResult(result)).not.toContain("calls: issueToken");
	});

	it("支持 qualified symbol", async () => {
		await writeFile(path.join(testContext.workspace, "auth.ts"), "export class AuthService {\n  async login(credentials: Credentials): Promise<Session> {\n    return issueToken();\n  }\n}\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "AuthService.login" }));
		expect(firstRegion(result)).toMatchObject({ symbol: "AuthService.login" });
		expect(firstRegion(result).matched_by).toContain("exact-qualified-symbol");
	});

	it("camelCase、snake_case、路径和 docstring 能被自然语言召回", async () => {
		await mkdir(path.join(testContext.workspace, "src"));
		await writeFile(path.join(testContext.workspace, "src", "session_token.py"), 'def issue_session_token(user):\n    """create authentication flow token"""\n    return user.id\n');
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "authentication flow session token" }));
		expect(firstRegion(result)).toMatchObject({ path: "src/session_token.py", symbol: "issue_session_token" });
		expect(firstRegion(result).matched_by).toContain("lexical");
	});

	it("related result 配置在排序后静默限制 semantic region", async () => {
		const configPath = path.join(testContext.outside, "related-result-limit.jsonc");
		await writeConfig(configPath, { grep_related_result_limit: 2 });
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		for (const name of ["alpha", "beta", "gamma"]) {
			await writeFile(path.join(testContext.workspace, `${name}.ts`), [
				`export function ${name}Candidate() {`,
				"  const authentication = true;",
				"  const flow = true;",
				"  return token;",
				"}",
			].join("\n"));
		}

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, {
			query: "authentication flow token",
		}));
		expect(result).toMatchObject({
			total_candidates: 2,
			returned_regions: 2,
			truncated_by: [],
			stats: { dropped_related_results: 1 },
		});
		expect(result.regions.every((region) => region.query_match === "semantic")).toBe(true);
		const output = formatCompactGrepResult(result);
		expect(output).not.toContain("truncated=");
		expect(output).not.toContain("omitted");
	});

	it("related result limit 为 0 时只禁用 semantic region", async () => {
		const configPath = path.join(testContext.outside, "related-result-disabled.jsonc");
		await writeConfig(configPath, { grep_related_result_limit: 0 });
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await writeFile(path.join(testContext.workspace, "candidates.ts"), [
			"export function semanticCandidate() {",
			"  const authentication = true;",
			"  const flow = true;",
			"  return token;",
			"}",
			"export function verifiedCandidate() {",
			"  return 'DirectNeedle';",
			"}",
		].join("\n"));

		const related = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, {
			query: "authentication flow token",
		}));
		expect(related).toMatchObject({
			total_candidates: 0,
			returned_regions: 0,
			truncated_by: [],
			regions: [],
		});
		expect(related.stats.dropped_related_results).toBeGreaterThan(0);
		expect(formatCompactGrepResult(related)).not.toContain("truncated=");

		const verified = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, {
			query: "DirectNeedle",
		}));
		expect(verified.returned_regions).toBe(1);
		expect(firstRegion(verified).query_match).toBe("verified");
	});

	it("有序且集中的同行命中优于反序散布命中", async () => {
		const padding = Array.from({ length: 16 }, (_, index) => `  const gap${index} = ${index};`);
		await writeFile(path.join(testContext.workspace, "proximity.ts"), [
			"export function scatteredTarget() {",
			"  gamma();",
			...padding,
			"  beta();",
			...padding,
			"  return alpha();",
			"}",
			"export function orderedTarget() {",
			"  return alpha(beta(gamma));",
			"}",
		].join("\n"));

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Alpha Beta Gamma" }));

		expect(firstRegion(result)).toMatchObject({ symbol: "orderedTarget", query_match: "semantic" });
	});

	it("将 phrase 文本候选折叠到最小 enclosing region", async () => {
		const padding = Array.from({ length: 90 }, (_, index) => `  const padding${index} = ${index};`).join("\n");
		await writeFile(path.join(testContext.workspace, "large.ts"), `export function focusedConcept() {\n  // authentication flow token\n${padding}\n  return true;\n}\n`);
		await writeFile(path.join(testContext.workspace, "small.ts"), [
			"export function scatteredConcept() {",
			"  const token = create();",
			"  const unrelated = true;",
			"  return flow(authentication, token, unrelated);",
			"}",
		].join("\n"));

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Authentication Flow Token" }));

		expect(firstRegion(result)).toMatchObject({ path: "large.ts", symbol: "focusedConcept", kind: "function", query_match: "semantic" });
		expect(firstRegion(result).matched_by).toContain("lexical");
	});

	it("regex 区分大小写并将同一代码单元的多个真实命中聚合", async () => {
		await writeFile(path.join(testContext.workspace, "a.ts"), "export function demo() {\n  const Token = 'Token';\n  const token = 'token';\n  return Token;\n}\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Token" }));
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
		await assertStrictMatches(testContext.workspace, result, "Token");
	});

	it("同一 method 的多个命中聚合，两个 sibling methods 保持独立锚点", async () => {
		await writeFile(path.join(testContext.workspace, "methods.ts"), [
			"export class Service {",
			"  first() {",
			"    consume(needle);",
			"    return needle;",
			"  }",
			"  second() {",
			"    return needle;",
			"  }",
			"}",
		].join("\n"));
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "needle" }));
		expect(result.regions).toEqual([
			expect.objectContaining({ symbol: "Service.first", start_line: 2, end_line: 5, match_lines: [3, 4] }),
			expect.objectContaining({ symbol: "Service.second", start_line: 6, end_line: 8, match_lines: [7] }),
		]);
	});

	it("只省略 declaration 范围内的重复命中，不吞掉 body 中的同词命中", async () => {
		await writeFile(path.join(testContext.workspace, "declaration-hit.ts"), [
			"export function needle() {",
			"  return needle();",
			"}",
		].join("\n"));
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "needle" }));
		expect(firstRegion(result)).toMatchObject({
			declaration: "export function needle()",
			match_lines: [1, 2],
			display_lines: [expect.objectContaining({ line: 2, text: "  return needle();" })],
		});
		expect(formatCompactGrepResult(result)).not.toContain("export function needle() {");
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
	] as const)("regex 将命中映射到最小 enclosing $name", async ({ query, content, expected }) => {
		await writeFile(path.join(testContext.workspace, "region.ts"), content);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query }));
		expect(firstRegion(result)).toMatchObject(expected);
		await assertStrictMatches(testContext.workspace, result, query);
	});

	it.each([
		["TopCommentNeedle", "// TopCommentNeedle\nexport const value = true;\n", 1],
		["ImportNeedle", "import { ImportNeedle } from './dependency';\nexport const value = true;\n", 1],
		["TopBodyNeedle", "console.log('TopBodyNeedle');\nexport const value = true;\n", 1],
	] as const)("AST 外正文 %s 安全降级为 verified 文本行", async (query, content, line) => {
		await writeFile(path.join(testContext.workspace, "outside.ts"), content);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query }));
		expect(firstRegion(result)).toMatchObject({ kind: "text", query_match: "verified", match_lines: [line] });
		await assertStrictMatches(testContext.workspace, result, query);
	});

	it("深度范围内的合规文件不受解析文件数量限制", async () => {
		await writeFile(path.join(testContext.workspace, "a.ts"), "export function first() { return 'BudgetNeedle'; }\n");
		await writeFile(path.join(testContext.workspace, "b.ts"), "export function second() { return 'BudgetNeedle'; }\n");

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "BudgetNeedle" }));

		expect(result.regions).toEqual([
			expect.objectContaining({ path: "a.ts", kind: "function", symbol: "first", match_lines: [1] }),
			expect.objectContaining({ path: "b.ts", kind: "function", symbol: "second", match_lines: [1] }),
		]);
		expect(result.stats.parsed_files).toBe(2);
		expect(result.stats.ast_skipped_oversized_files).toBe(0);
		await assertStrictMatches(testContext.workspace, result, "BudgetNeedle");
	});

	it("parse 单文件字节上限保留 verified 文本行并记录内部观测", async () => {
		const configPath = path.join(testContext.outside, "strict-parse-bytes.jsonc");
		await writeConfig(configPath, { grep_ast_max_file_bytes: 1024 });
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await writeFile(path.join(testContext.workspace, "large-region.ts"), `export function largeRegion() {\n  return '${"padding".repeat(180)} ParseBytesNeedle';\n}\n`);

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "ParseBytesNeedle" }));

		expect(firstRegion(result)).toMatchObject({ path: "large-region.ts", kind: "text", match_lines: [2] });
		expect(result.stats.parsed_files).toBe(0);
		expect(result.stats.ast_skipped_oversized_files).toBe(1);
		expect(result.truncated_by).toEqual([]);
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

		const cold = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "CacheNeedle" }));
		const warm = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "CacheNeedle" }));
		expect(snapshot(warm)).toEqual(snapshot(cold));
		expect(firstRegion(warm)).toMatchObject({ kind: "function", symbol: "cached", match_lines: [2] });

		await writeFile(originalPath, "// CacheNeedle moved outside every declaration\nexport const current = true;\n");
		const modified = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "CacheNeedle" }));
		expect(firstRegion(modified)).toMatchObject({ path: "cache.ts", kind: "text", match_lines: [1] });
		expect(firstRegion(modified).symbol).toBeUndefined();

		await rename(originalPath, renamedPath);
		const renamed = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "CacheNeedle" }));
		expect(renamed.regions.map((region) => region.path)).toEqual(["renamed.ts"]);
		await rm(renamedPath);
		const deleted = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "CacheNeedle" }));
		expect(deleted.regions).toEqual([]);
	});

	it("regionizer 用 inventory snapshot 拒绝 stat 后发生的同 size 正文替换", async () => {
		const filePath = path.join(testContext.workspace, "race-region.ts");
		const hitLine = "  return 'RaceNeedle';";
		const originalFirstLine = "export function before() {";
		const replacementFirstLine = "export const changed = 1;".padEnd(originalFirstLine.length, " ");
		const originalText = `${originalFirstLine}\n${hitLine}\n}\n`;
		const replacementText = `${replacementFirstLine}\n${hitLine}\n}\n`;
		expect(Buffer.byteLength(replacementText)).toBe(Buffer.byteLength(originalText));
		await writeFile(filePath, originalText);
		await withGrepRuntime(testContext.workspace, "grep-region-race", async ({ tool, opened }) => {
			const metadata = opened.filesystem.metadata;
			let changed = false;
			let metadataReads = 0;
			const filesystem = overrideContent(
				{
					...opened.filesystem,
					metadata: {
						...metadata,
						async stat(ref, context) {
							metadataReads += 1;
							return await metadata.stat(ref, context);
						},
					},
				},
				(content) => ({
					async readText(file, options, context) {
						expect(options.expectedSnapshot).toBeDefined();
						if (!changed) {
							changed = true;
							await writeFile(filePath, replacementText);
							await utimes(filePath, new Date(946_684_800_000), new Date(946_684_800_000));
						}
						return await content.readText(file, options, context);
					},
				}),
			);
			const result = expectGrepSuccess(await tool.execute({ query: "RaceNeedle" }, {
				filesystem,
				operation: opened.context,
				limits: opened.limits,
			}));
			expect(result.regions).toEqual([]);
			expect(result.stats.skipped_files).toMatchObject({ changed: 1 });
			expect(metadataReads).toBe(0);
		});
	});

	it("visibility fingerprint 变化后 cache 不会补回被 ignore 的文件", async () => {
		const configPath = path.join(testContext.outside, "visibility-cache.jsonc");
		await writeConfig(configPath);
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await mkdir(path.join(testContext.workspace, "hidden"));
		await writeFile(path.join(testContext.workspace, "hidden", "cached.ts"), "export function hidden() { return 'VisibilityNeedle'; }\n");
		const visible = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "VisibilityNeedle" }));
		expect(firstRegion(visible)).toMatchObject({ path: "hidden/cached.ts", kind: "function" });

		await writeFile(configPath, JSON.stringify({
			blocked_path: [".git/"],
			ignored_path: ["hidden/"],
			ignore: { builtin_profile: "none", gitignore: false },
		}));
		const ignored = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "VisibilityNeedle" }));
		expect(ignored.regions).toEqual([]);
		const explicit = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, {
			path: ["hidden/cached.ts"],
			query: "VisibilityNeedle",
					}));
		expect(firstRegion(explicit)).toMatchObject({ path: "hidden/cached.ts", kind: "function" });
	});

	it("regionizer 直接使用 scanner 与 AST 的正文 UTF-8 byte offset", async () => {
		await writeFile(path.join(testContext.workspace, "utf8.ts"), Buffer.concat([
			Buffer.from([0xef, 0xbb, 0xbf]),
			Buffer.from("export function utf8() { return '😀 Utf8RegionNeedle'; }\n"),
		]));
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Utf8RegionNeedle" }));
		expect(firstRegion(result)).toMatchObject({ kind: "function", symbol: "utf8", match_lines: [1] });
	});

	it.each([
		["CRLF", "export function newline() {\r\n  return 'RegionNewlineNeedle';\r\n}\r\n", "function"],
		["CR", "export function newline() {\r  return 'RegionNewlineNeedle';\r}\r", "text"],
	] as const)("regionizer 对 %s 保持 logical match line，不能安全解析时降级", async (_name, content, kind) => {
		await writeFile(path.join(testContext.workspace, "newline.ts"), content);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "RegionNewlineNeedle" }));
		expect(firstRegion(result)).toMatchObject({ kind, match_lines: [2], query_match: "verified" });
	});

	it("regex 冷暖 cache 都从当前 snapshot 单次读取代码正文", async () => {
		await writeFile(path.join(testContext.workspace, "warm.ts"), "export function warm() { return 'WarmNeedle'; }\n");
		await withGrepRuntime(testContext.workspace, "grep-strict-warm", async ({ tool, opened }) => {
			let scans = 0;
			let fullReads = 0;
			const filesystem = overrideContent(opened.filesystem, (content) => ({
				async readText(file, options, context) {
					fullReads += 1;
					return await content.readText(file, options, context);
				},
				async scanLines(file, options, context) {
					scans += 1;
					return await content.scanLines(file, options, context);
				},
			}));
			const results: GrepSuccess[] = [];
			for (let index = 0; index < 2; index += 1) {
				results.push(expectGrepSuccess(await tool.execute({ query: "WarmNeedle" }, {
					filesystem,
					operation: opened.context,
					limits: opened.limits,
				})));
			}
			expect({ scans, fullReads }).toEqual({ scans: 0, fullReads: 2 });
			expect(results[1]?.regions).toEqual(results[0]?.regions);
		});
	});
});

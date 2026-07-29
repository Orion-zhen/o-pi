import { chmod, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { WorkspaceFileSystem } from "../../src/filesystem/contracts/workspace.js";
import { formatCompactGrepResult, GrepTool } from "../../src/file-tools/grep/command.js";
import { grepWorkspaceFiles } from "../helpers/grep-tool.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { isFailed } from "../../src/file-tools/shared/result.js";
import type { GrepSuccess } from "../../src/file-tools/grep/types.js";
import { clearGrepTestRuntime as clearGrepIndex } from "../helpers/grep-tool.js";
import { createGrepTestContext, expectGrepSuccess, firstRegion, writeConfig } from "./grep-fixtures.js";

const testContext = createGrepTestContext();

describe("grep integration", () => {
	it("文件修改、删除、重命名和 ignore 变化会更新索引", async () => {
		await writeFile(path.join(testContext.workspace, "a.ts"), "export function oldName() {}\n");
		expect(firstRegion(expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "oldName" }))).symbol).toBe("oldName");
		await writeFile(path.join(testContext.workspace, "a.ts"), "export function newName() {}\n");
		expect(firstRegion(expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "newName" }))).symbol).toBe("newName");
		await rename(path.join(testContext.workspace, "a.ts"), path.join(testContext.workspace, "renamed.ts"));
		expect(firstRegion(expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "newName" })))).toMatchObject({ path: "renamed.ts" });
		await rm(path.join(testContext.workspace, "renamed.ts"));
		expect(expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "newName" })).regions).toHaveLength(0);
		await writeFile(path.join(testContext.workspace, ".piignore"), "ignored.ts\n");
		await writeFile(path.join(testContext.workspace, "ignored.ts"), "export function hiddenNeedle() {}\n");
		expect(expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "hiddenNeedle" })).regions).toHaveLength(0);
	});

	it("显式 grep 允许读取 soft ignored 文件和目录内容", async () => {
		await writeFile(path.join(testContext.workspace, ".piignore"), "ignored.ts\nignored-dir/\n");
		await mkdir(path.join(testContext.workspace, "ignored-dir"));
		await writeFile(path.join(testContext.workspace, "ignored.ts"), "export function hiddenFileNeedle() {}\n");
		await writeFile(path.join(testContext.workspace, "ignored-dir", "secret.ts"), "export function hiddenDirNeedle() {}\n");

		expect(expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "hiddenFileNeedle" })).regions).toHaveLength(0);
		expect(expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "hiddenDirNeedle" })).regions).toHaveLength(0);
		expect(firstRegion(expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["ignored.ts"], query: "hiddenFileNeedle" })))).toMatchObject({
			path: "ignored.ts",
			symbol: "hiddenFileNeedle",
		});
		expect(firstRegion(expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["ignored-dir"], query: "hiddenDirNeedle" })))).toMatchObject({
			path: "ignored-dir/secret.ts",
			symbol: "hiddenDirNeedle",
		});
	});

	it("完整扫描清理已删除文件的 parsed cache", async () => {
		const oldSource = "export const oldName = 1;\n";
		const newSource = "export const newName = 1;\n";
		expect(Buffer.byteLength(oldSource)).toBe(Buffer.byteLength(newSource));
		await writeFile(path.join(testContext.workspace, "cached.ts"), oldSource);
		const host = new FileToolsHost();
		const tool = new GrepTool();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-cache-prune" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		const execute = async (query: string): Promise<GrepSuccess> => expectGrepSuccess(await tool.execute({ query }, {
			filesystem: opened.filesystem,
			operation: opened.context,
			limits: opened.limits,
		}));
		try {
			expect(firstRegion(await execute("oldName"))).toMatchObject({ path: "cached.ts", symbol: "oldName" });
			await rm(path.join(testContext.workspace, "cached.ts"));
			expect((await execute("cleanupMiss")).regions).toEqual([]);
			await writeFile(path.join(testContext.workspace, "cached.ts"), newSource);
			expect((await execute("oldName")).regions.every((region) => region.symbol !== "oldName")).toBe(true);
			expect(firstRegion(await execute("newName"))).toMatchObject({ path: "cached.ts", symbol: "newName" });
		} finally {
			tool.dispose();
			opened.dispose();
			host.dispose();
		}
	});

	it("缓存只保存派生索引，重复事实查询仍返回实时证据行", async () => {
		await writeFile(path.join(testContext.workspace, "target.ts"), "export function targetNeedle() {\n  return 42;\n}\n");
		const first = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "return 42" }));
		expect(firstRegion(first).display_lines?.[0]?.text).toContain("return 42");

		await writeFile(path.join(testContext.workspace, "target.ts"), "export function targetNeedle() {\n  return 84;\n}\n");
		const second = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "return 84" }));
		expect(firstRegion(second).display_lines?.[0]?.text).toContain("return 84");
		expect(firstRegion(second).display_lines?.[0]?.text).not.toContain("return 42");
	});

	it.each([
		{ name: "AST 外注释", file: "comment.ts", query: "AutoCommentNeedle", content: "// AutoCommentNeedle\nexport const value = true;\n" },
		{ name: "字符串", file: "string.ts", query: "AutoStringNeedle", content: "export const message = 'AutoStringNeedle';\n" },
		{ name: "顶层正文", file: "top-level.ts", query: "AutoTopLevelNeedle", content: "AutoTopLevelNeedle\nexport const value = true;\n" },
		{ name: "unsupported 文件", file: "notes.conf", query: "AutoUnsupportedNeedle", content: "mode=AutoUnsupportedNeedle\n" },
	])("统一正文召回：$name", async ({ file, query, content }) => {
		await writeFile(path.join(testContext.workspace, file), content);
		const literal = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: [file], query }));
		const cold = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: [file], query }));
		const warm = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: [file], query }));
		const verifiedLines = (result: GrepSuccess) => result.regions.flatMap((region) =>
			(region.match_lines ?? []).map((line) => `${region.path}:${line}`));

		expect(verifiedLines(cold).length).toBeGreaterThan(0);
		for (const line of verifiedLines(literal)) expect(verifiedLines(cold)).toContain(line);
		expect(verifiedLines(warm)).toEqual(verifiedLines(cold));
		expect(warm.regions.map(({ path: filePath, start_line, end_line, kind, symbol }) => ({ filePath, start_line, end_line, kind, symbol })))
			.toEqual(cold.regions.map(({ path: filePath, start_line, end_line, kind, symbol }) => ({ filePath, start_line, end_line, kind, symbol })));
	});

	it("统一链路在深度范围内解析全部合规小文件并保留直接文本候选", async () => {
		await writeFile(path.join(testContext.workspace, "a.ts"), "export function first() { return 'AutoBudgetNeedle'; }\n");
		await writeFile(path.join(testContext.workspace, "b.ts"), "export function second() { return 'AutoBudgetNeedle'; }\n");

		const literal = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "AutoBudgetNeedle" }));
		const auto = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "AutoBudgetNeedle" }));
		expect(auto.regions.map((region) => region.path)).toEqual(literal.regions.map((region) => region.path));
		expect(auto.stats.parsed_files).toBe(2);
		expect(auto.stats.ast_skipped_oversized_files).toBe(0);
	});

	it("单次 line scan 同时服务 exact 与 lexical，不重复扫描正文", async () => {
		await writeFile(path.join(testContext.workspace, "first.ts"), "export function retryPolicy() { return 'session delay'; }\n");
		await writeFile(path.join(testContext.workspace, "second.conf"), "session retry delay\n");
		const host = new FileToolsHost();
		const tool = new GrepTool();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-auto-single-scan" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		let lineScans = 0;
		const original = opened.filesystem.content;
		const filesystem: WorkspaceFileSystem = {
			...opened.filesystem,
			content: {
				readBytes: original.readBytes.bind(original),
				readText: original.readText.bind(original),
				decodeText: original.decodeText.bind(original),
				sliceText: original.sliceText.bind(original),
				async scanLines(file, options, context) {
					lineScans += 1;
					return await original.scanLines(file, options, context);
				},
			},
		};
		try {
			const result = expectGrepSuccess(await tool.execute({ query: "session retry delay" }, {
				filesystem,
				operation: opened.context,
				limits: opened.limits,
			}));
			expect(result.regions.length).toBeGreaterThan(0);
			expect(lineScans).toBe(2);
		} finally {
			tool.dispose();
			opened.dispose();
			host.dispose();
		}
	});

	it("不解释关系语言，只按正文或 related 证据返回", async () => {
		await writeFile(path.join(testContext.workspace, "service.ts"), "export function login() { return true; }\n");
		await writeFile(path.join(testContext.workspace, "route.ts"), "export function handleRequest() { return login(); }\n");

		const explicit = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "callers of login" }));
		expect(explicit.regions).toEqual([]);
		const ordinary = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "login" }));
		expect(ordinary.regions.every((region) => region.query_match === "verified")).toBe(true);
	});

	it("自然语言 lexical 要求多词覆盖，部分词项不产生候选", async () => {
		await mkdir(path.join(testContext.workspace, "session"));
		await writeFile(path.join(testContext.workspace, "session", "common.ts"), "export const data = true;\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "data retry policy" }));
		expect(result.regions).toEqual([]);
		expect(formatCompactGrepResult(result)).toContain("next: broaden query/path/glob");
	});

	it("unsupported language 安全退化到文本行", async () => {
		await writeFile(path.join(testContext.workspace, "notes.conf"), "section=true\nfatal authentication error\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "fatal authentication error" }));
		expect(firstRegion(result)).toMatchObject({ path: "notes.conf", kind: "text", display_lines: [expect.objectContaining({ type: "match" })] });

		const auto = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "authentication error" }));
		expect(firstRegion(auto)).toMatchObject({ path: "notes.conf", kind: "text", matched_by: ["regex"] });
		const warmLexical = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "fatal error" }));
		expect(firstRegion(warmLexical)).toMatchObject({ path: "notes.conf", kind: "text", matched_by: ["lexical"] });
		expect(formatCompactGrepResult(warmLexical)).toContain("notes.conf:2 [not match, related]: fatal authentication error");
	});

	it("binary、invalid UTF-8、无正文大小上限、blocked path 和 symlink 行为保持", async () => {
		await writeFile(path.join(testContext.workspace, "ok.txt"), "needle\n");
		await writeFile(path.join(testContext.workspace, "binary.bin"), Buffer.from([0, 1, 2]));
		await writeFile(path.join(testContext.workspace, "bad.txt"), Buffer.from([0xc3, 0x28]));
		await writeFile(path.join(testContext.workspace, "large.txt"), `${"x".repeat(5000)}needle\n`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "needle" }));
		expect(result.stats.skipped_files).toMatchObject({ binary: 1, invalid_utf8: 1 });
		expect(result.stats.searched_files).toBe(2);
		expect(await grepWorkspaceFiles(testContext.workspace, { path: ["binary.bin"], query: "needle" }))
			.toMatchObject({ status: "failed", error: { code: "BINARY_FILE_UNSUPPORTED" } });
		expect(await grepWorkspaceFiles(testContext.workspace, { path: ["bad.txt"], query: "needle" }))
			.toMatchObject({ status: "failed", error: { code: "ENCODING_UNSUPPORTED" } });
		expect(await grepWorkspaceFiles(testContext.workspace, { path: ["large.txt"], query: "needle" }))
			.toMatchObject({ status: "success", stats: { searched_files: 1 } });
		const partial = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, {
			path: ["bad.txt", "ok.txt"],
			query: "needle",
					}));
		expect(partial.regions.map((region) => region.path)).toEqual(["ok.txt"]);
		expect(partial.scope_errors).toMatchObject([{ path: "bad.txt", error: { code: "ENCODING_UNSUPPORTED" } }]);
		await mkdir(path.join(testContext.workspace, ".git"));
		await writeFile(path.join(testContext.workspace, ".git", "config"), "needle\n");
		expect(await grepWorkspaceFiles(testContext.workspace, { path: [".git/config"], query: "needle" })).toMatchObject({ status: "failed", error: { code: "PROTECTED_PATH" } });
		await writeFile(path.join(testContext.outside, "secret.txt"), "needle\n");
		try {
			await symlink(path.join(testContext.outside, "secret.txt"), path.join(testContext.workspace, "link.txt"));
		} catch {
			return;
		}
		expect(firstRegion(expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["link.txt"], query: "needle" })))).toMatchObject({
			path: "link.txt",
		});
		const configPath = path.join(testContext.outside, "blocked-realpath.jsonc");
		await writeConfig(configPath);
		const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
		raw.blocked_path = [`${testContext.outside}/`];
		await writeFile(configPath, JSON.stringify(raw, null, 2));
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		clearGrepIndex();
		expect(await grepWorkspaceFiles(testContext.workspace, { path: ["link.txt"], query: "needle" })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH" },
		});
	});

	it.skipIf(process.platform === "win32")("递归搜索跳过局部权限失败", async () => {
		await writeFile(path.join(testContext.workspace, "ok.txt"), "needle\n");
		await mkdir(path.join(testContext.workspace, "locked"));
		await writeFile(path.join(testContext.workspace, "locked", "secret.txt"), "needle\n");
		await chmod(path.join(testContext.workspace, "locked"), 0o000);
		try {
			const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "needle" }));
			expect(result.stats.skipped_files).toMatchObject({ access_denied: 1 });
		} finally {
			await chmod(path.join(testContext.workspace, "locked"), 0o700);
		}
	});

	it("AbortSignal、稳定排序和零结果", async () => {
		await writeFile(path.join(testContext.workspace, "b.ts"), "export function betaSearch() {}\n");
		await writeFile(path.join(testContext.workspace, "a.ts"), "export function alphaSearch() {}\n");
		const first = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Search" }));
		const second = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Search" }));
		expect(first.regions.map((region) => region.path)).toEqual(second.regions.map((region) => region.path));
		const zero = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "alpha missing" }));
		expect(zero.regions).toHaveLength(0);
		const controller = new AbortController();
		controller.abort();
		expect(await grepWorkspaceFiles(testContext.workspace, { query: "Search" }, controller.signal)).toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
	});

	it("symbol typo 没有 LSP 或词项证据时返回空 related 集合", async () => {
		await writeFile(path.join(testContext.workspace, "auth.ts"), "export function authenticate() { return true; }\n");

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "authentcate" }));

		expect(result.regions).toEqual([]);
		expect(result.stats.parsed_files).toBe(1);
		expect(formatCompactGrepResult(result)).toContain("next: broaden query/path/glob");
	});

	it.each(["MissingNeedle", "Missing\\d+"])("query=%s 零命中返回扫描范围和可执行下一步", async (query) => {
		await writeFile(path.join(testContext.workspace, "auth.ts"), "export function authenticateUser() { return true; }\n");

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query }));

		expect(result.regions).toEqual([]);
		expect(result.stats.searched_files).toBe(1);
		expect(formatCompactGrepResult(result)).toBe([
			"<grep>",
			"none",
			"searched=1; skipped=0",
			"next: broaden query/path/glob",
			"</grep>",
		].join("\n"));
	});

	it("共享索引构建时单个调用取消不影响其他调用", async () => {
		for (let index = 0; index < 60; index += 1) {
			await writeFile(path.join(testContext.workspace, `module-${index}.ts`), `export function symbol${index}() { return ${index}; }\n`);
		}
		await writeFile(path.join(testContext.workspace, "target.ts"), "export function sharedTarget() { return true; }\n");
		const controller = new AbortController();
		const aborted = grepWorkspaceFiles(testContext.workspace, { query: "sharedTarget" }, controller.signal);
		const completed = grepWorkspaceFiles(testContext.workspace, { query: "sharedTarget" });
		setImmediate(() => controller.abort());

		expect(await aborted).toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
		expect(firstRegion(expectGrepSuccess(await completed)).symbol).toBe("sharedTarget");
	});

	it("统一链路对深度范围内的合规小文件不设置解析数量上限", async () => {
		for (let index = 0; index < 56; index += 1) {
			await writeFile(path.join(testContext.workspace, `low-${index}.ts`), `export function low${index}() { return 'semantic loader'; }\n`);
		}
		await writeFile(
			path.join(testContext.workspace, "target.ts"),
			"export function retryPolicy() { return 'semantic loader retry policy'; }\n",
		);

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "semantic loader retry policy" }));

		expect(result.stats).toMatchObject({ searched_files: 57, parsed_files: 57 });
		expect(result.stats.ast_skipped_oversized_files).toBe(0);
		expect(result.regions).toEqual(expect.arrayContaining([expect.objectContaining({ path: "target.ts", symbol: "retryPolicy" })]));
	});

	it("query miss 每次都重新执行当前 snapshot 的 line scan", async () => {
		await writeFile(path.join(testContext.workspace, "miss.txt"), "unrelated\n");
		const host = new FileToolsHost();
		const tool = new GrepTool();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-query-miss" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		let fullReads = 0;
		let lineScans = 0;
		const filesystem: WorkspaceFileSystem = {
			...opened.filesystem,
			content: {
				readBytes: opened.filesystem.content.readBytes.bind(opened.filesystem.content),
				async readText(file, options, context) {
					fullReads += 1;
					return await opened.filesystem.content.readText(file, options, context);
				},
				decodeText: opened.filesystem.content.decodeText.bind(opened.filesystem.content),
				sliceText: opened.filesystem.content.sliceText.bind(opened.filesystem.content),
				async scanLines(file, options, context) {
					lineScans += 1;
					return await opened.filesystem.content.scanLines(file, options, context);
				},
			},
		};
		try {
			for (const query of ["first-miss", "second-miss", "first-miss"]) {
				const result = expectGrepSuccess(await tool.execute({ query }, {
					filesystem,
					operation: opened.context,
					limits: opened.limits,
				}));
				expect(result.regions).toEqual([]);
			}
			expect({ fullReads, lineScans }).toEqual({ fullReads: 0, lineScans: 3 });
		} finally {
			tool.dispose();
			opened.dispose();
			host.dispose();
		}
	});

	it("超大 scope 的 regex 不受文件数量限制", async () => {
		for (let index = 0; index < 52; index += 1) {
			await writeFile(path.join(testContext.workspace, `filler-${index}.ts`), `export const filler${index} = ${index};\n`);
		}
		await writeFile(path.join(testContext.workspace, "z-target.ts"), "export const target = 'StrictNeedle';\n");

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "StrictNeedle" }));

		expect(result.truncated_by).toEqual([]);
		expect(firstRegion(result).path).toBe("z-target.ts");
	});

	it("大代码文件跳过 Tree-sitter 但保留完整文本召回并记录内部观测", async () => {
		const configPath = path.join(testContext.outside, "semantic-parse-bytes.jsonc");
		await writeConfig(configPath, { grep_ast_max_file_bytes: 1024 });
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		for (let index = 0; index < 48; index += 1) {
			await writeFile(path.join(testContext.workspace, `small-${index}.ts`), `export const small${index} = ${index};\n`);
		}
		await writeFile(
			path.join(testContext.workspace, "generated.ts"),
			`${"const padding = 1;\n".repeat(80)}export const generated = 'oversized semantic phrase';\n`,
		);

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "oversized semantic phrase" }));

		expect(result.truncated_by).toEqual([]);
		expect(result.stats.ast_skipped_oversized_files).toBe(1);
		expect(firstRegion(result)).toMatchObject({ path: "generated.ts", kind: "text" });
		expect(firstRegion(result).display_lines?.[0]?.text).toContain("oversized semantic phrase");
	});

	it("多个 scope 按 union 合并并共享输出结果", async () => {
		await mkdir(path.join(testContext.workspace, "src"), { recursive: true });
		await mkdir(path.join(testContext.workspace, "tests"), { recursive: true });
		await writeFile(path.join(testContext.workspace, "src", "a.ts"), "const needle = 1;\n");
		await writeFile(path.join(testContext.workspace, "tests", "b.ts"), "const needle = 2;\n");

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, {
			query: "needle",
			path: ["src", "tests"],
					}));
		expect(result.paths).toEqual(["src", "tests"]);
		expect(result.regions.map((region) => region.path)).toEqual(["src/a.ts", "tests/b.ts"]);
		const output = formatCompactGrepResult(result);
		expect(output).toContain("\n  needle = 1");
		expect(output).not.toContain("declaration:");
	});

	it("嵌套和重复 scope 不产生重复区域", async () => {
		await mkdir(path.join(testContext.workspace, "src", "lib"), { recursive: true });
		await writeFile(path.join(testContext.workspace, "src", "lib", "a.ts"), "const nestedNeedle = true;\n");
		await writeFile(path.join(testContext.workspace, "src", "b.ts"), "const nestedNeedle = false;\n");

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, {
			query: "nestedNeedle",
			path: ["src/lib", "src", "src"],
					}));
		expect(result.paths).toEqual(["src/lib", "src"]);
		expect(new Set(result.regions.map((region) => region.path)).size).toBe(result.regions.length);
	});

	it("一个 scope 失败时保留结果并在模型输出中标注错误", async () => {
		await mkdir(path.join(testContext.workspace, "src"), { recursive: true });
		await writeFile(path.join(testContext.workspace, "src", "available.ts"), "const partialNeedle = true;\n");

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, {
			query: "partialNeedle",
			path: ["src", "missing"],
					}));
		expect(result.scope_errors).toMatchObject([{ path: "missing", error: { code: "PATH_NOT_FOUND" } }]);
		expect(formatCompactGrepResult(result)).toContain("partial; scope_errors=missing:PATH_NOT_FOUND");
	});

	it("所有 scope 失败时返回 FailedResult", async () => {
		const result = await grepWorkspaceFiles(testContext.workspace, { query: "needle", path: ["missing", "also-missing"] });
		expect(result).toMatchObject({
			status: "failed",
			error: { code: "PATH_NOT_FOUND", details: { scope_errors: expect.any(Array) } },
		});
	});

	it("多个 scope 共享 grep 结果限制", async () => {
		const configPath = path.join(testContext.outside, "multi-scope-limit.jsonc");
		await writeConfig(configPath, { grep_result_limit: 2 });
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await mkdir(path.join(testContext.workspace, "src"), { recursive: true });
		await mkdir(path.join(testContext.workspace, "tests"), { recursive: true });
		for (const [directory, name] of [["src", "a.ts"], ["src", "b.ts"], ["tests", "c.ts"], ["tests", "d.ts"]] as const) {
			await writeFile(path.join(testContext.workspace, directory, name), "const limitedNeedle = true;\n");
		}

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, {
			query: "limitedNeedle",
			path: ["src", "tests"],
					}));
		expect(result.total_candidates).toBe(4);
		expect(result.returned_regions).toBe(2);
		expect(result.truncated_by).toContain("result_limit");
		expect(formatCompactGrepResult(result)).toContain('<grep truncated="result_limit">');
	});

	it("输出超过旧 token budget 时仍只按结果条数限制", async () => {
		const configPath = path.join(testContext.outside, "result-limit.jsonc");
		await writeConfig(configPath, { grep_result_limit: 10 });
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		for (let index = 0; index < 10; index += 1) {
			await writeFile(
				path.join(testContext.workspace, `module-${index}.ts`),
				`export function importantNeedle${index}(value: string): string { return value + "needle"; }\n`,
			);
		}
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "needle" }));
		expect(result.returned_regions).toBe(10);
		expect(result.truncated_by).toEqual([]);
		expect(result.regions.every((region) => !("content" in region) && !("detail" in region))).toBe(true);
		expect(result.regions.flatMap((region) => region.display_lines ?? []).every((line) => [...line.text].length <= 240)).toBe(true);
		expect(result.approx_tokens).toBeGreaterThan(260);
	});
});

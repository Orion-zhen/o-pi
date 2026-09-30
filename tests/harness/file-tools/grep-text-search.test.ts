import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { buildScopeInventory } from "../../../src/harness/file-tools/grep/inventory.ts";
import { scanInventoryText } from "../../../src/harness/file-tools/grep/text-scanner.ts";
import { countTextTokensSync } from "../../../src/harness/token-counter.ts";
import { formatCompactGrepResult } from "../../../src/harness/file-tools/grep/command.ts";
import { compactDisplayLine } from "../../../src/harness/file-tools/grep/display.ts";
import { deferredVoid } from "../../helpers/async.ts";
import { grepWorkspaceFiles } from "../../helpers/grep-tool.ts";
import {
	assertStrictMatches,
	createGrepTestContext,
	expectGrepSuccess,
	expectInventorySuccess,
	expectSuccess,
	firstRegion,
	grepWithAnalyzer,
	overrideContent,
	withFileToolsInvocation,
} from "./grep-fixtures.ts";
import { createQueryPlan } from "../../../src/harness/file-tools/grep/query-plan.ts";

const queryPlan = (query: string) => expectSuccess(createQueryPlan({ query }));

const testContext = createGrepTestContext();

describe("grep text search", () => {
	it("截断提示按全部候选统计可缩小的范围，不只统计已展示结果", async () => {
		await testContext.useConfig({ grep_result_limit: 1 }, "navigation");
		for (const name of ["alpha", "beta"]) await mkdir(path.join(testContext.workspace, name));
		await writeFile(path.join(testContext.workspace, "alpha/a.conf"), "needle one\nneedle two\n");
		await writeFile(path.join(testContext.workspace, "beta/b.conf"), "needle three\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "needle" }));
		expect(result.navigation?.narrow).toEqual([{ path: "alpha", count: 2 }, { path: "beta", count: 1 }]);
		const complete = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["beta"], query: "needle" }));
		expect(complete).not.toHaveProperty("navigation");
		expect(formatCompactGrepResult(complete)).not.toContain("next:");
	});

	it("字节预算截断报告未纳入扫描的文件与后续范围", async () => {
		await testContext.useConfig({ grep_max_search_bytes: 1024 }, "byte-navigation");
		for (const name of ["a", "b", "c"]) await writeFile(path.join(testContext.workspace, `${name}.conf`), `needle${"x".repeat(594)}`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["a.conf", "b.conf", "c.conf"], query: "needle" }));
		expect(result.truncated_by).toContain("byte_limit");
		expect(result.stats.searched_files).toBe(1);
		expect(result.navigation?.incomplete).toEqual(["b.conf", "c.conf"]);
		expect(formatCompactGrepResult(result)).toContain('incomplete: ["b.conf","c.conf"]');
	});

	it("深度截断下的零命中保留具体未搜索子目录", async () => {
		await testContext.useConfig({ grep_max_depth: 1 }, "depth-navigation");
		await mkdir(path.join(testContext.workspace, "src/deep"), { recursive: true });
		await writeFile(path.join(testContext.workspace, "src/deep/a.conf"), "needle\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["src"], query: "needle" }));
		expect(result.navigation?.incomplete).toEqual(["src/deep"]);
		expect(formatCompactGrepResult(result)).toContain('incomplete: ["src/deep"]');
	});

	it.each(["/absolute.ts", "../escape.ts", "a/../escape.ts", "bad\0glob"])("拒绝越界或 NUL glob %j", async (glob) => {
		await expect(grepWorkspaceFiles(testContext.workspace, { query: "needle", glob })).resolves.toMatchObject({
			status: "failed",
			error: { code: "INVALID_PATH" },
		});
	});

	it.each(["needle\nnext", "needle\rnext"])("拒绝 CR/LF 多行 query %j", async (query) => {
		await expect(grepWorkspaceFiles(testContext.workspace, { query })).resolves.toMatchObject({
			status: "failed",
			error: { code: "INVALID_OPERATION" },
		});
	});

	it.each([
		["LF", "alpha\nNeedle42\nomega\n"],
		["CRLF", "alpha\r\nNeedle42\r\nomega\r\n"],
		["CR", "alpha\rNeedle42\romega\r"],
	] as const)("regex 对 %s 使用统一 logical line 语义", async (_newline, content) => {
		await writeFile(path.join(testContext.workspace, "lines.txt"), content);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Needle42" }));
		expect(firstRegion(result)).toMatchObject({ match_lines: [2], query_match: "verified" });
		expect(firstRegion(result).display_lines?.[0]?.text).toContain("Needle42");
	});

	it("显式 literal 按精确文本搜索，非法 regex 不再探测正文或启动分析", async () => {
		await writeFile(path.join(testContext.workspace, "literal.ts"), "const value = read(input);\n");
		const analyzeCode = vi.fn(async () => undefined);
		const literal = expectGrepSuccess(await grepWithAnalyzer(testContext.workspace, {
			path: ["literal.ts"],
			query: "read(input",
			mode: "literal",
		}, { analyzeCode }));
		expect(literal.query_mode).toBe("literal");
		expect(firstRegion(literal)).toMatchObject({
			query_match: "verified",
			matched_by: ["literal"],
			sources: ["text-literal"],
		});
		expect(formatCompactGrepResult(literal)).not.toContain("warning:");
		await assertStrictMatches(testContext.workspace, literal, "read(input");

		const malformedAlternation = await grepWithAnalyzer(testContext.workspace, {
			path: ["literal.ts"],
			query: "read(input",
		}, { analyzeCode });
		expect(malformedAlternation).toMatchObject({
			status: "failed",
			error: {
				code: "INVALID_REGEX",
				next: expect.stringContaining('mode="literal"'),
			},
		});
		expect(analyzeCode).toHaveBeenCalledOnce();
	});

	it("literal 对合法正则文本仍保持精确匹配，零命中不是正则错误", async () => {
		await writeFile(path.join(testContext.workspace, "literal.conf"), "foo.bar\nfooXbar\n$schema\nitems[index]\n");
		for (const query of ["foo.bar", "$schema", "items[index]"]) {
			const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, {
				path: ["literal.conf"], query, mode: "literal",
			}));
			expect(result.regions).toHaveLength(1);
			await assertStrictMatches(testContext.workspace, result, query);
		}
		const missing = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, {
			path: ["literal.conf"], query: "missing(", mode: "literal",
		}));
		expect(missing.regions).toEqual([]);
		const regex = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, {
			path: ["literal.conf"], query: "foo.bar", mode: "regex",
		}));
		expect(regex.regions).toHaveLength(2);
	});

	it("AST 外文本使用单行协议，并对同一行的多个 occurrence 去重", async () => {
		await writeFile(path.join(testContext.workspace, "facts.conf"), "needle needle\n");
		const verified = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["facts.conf"], query: "needle" }));
		expect(verified.regions).toHaveLength(1);
		expect(firstRegion(verified)).toMatchObject({ kind: "text", match_lines: [1], display_lines: [{ line: 1, text: "needle needle", type: "match" }] });
		expect(formatCompactGrepResult(verified)).toContain("facts.conf:1: needle needle");
		expect(formatCompactGrepResult(verified)).not.toContain("kind=text");

		await writeFile(path.join(testContext.workspace, "semantic.conf"), "authentication request rejected\n");
		const semantic = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["semantic.conf"], query: "authentication rejected" }));
		expect(firstRegion(semantic)).toMatchObject({ kind: "text", query_match: "semantic", matched_by: ["lexical"] });
	});

	it("同文件 text region 只在模型文本中分组，候选和结果限制仍逐行计算", async () => {
		await testContext.useConfig({ grep_result_limit: 2, grep_regional_display_limit: 1 }, "text-render-group");
		await writeFile(path.join(testContext.workspace, "grouped.conf"), [
			"needle first",
			"needle second",
			"needle third",
		].join("\n"));

		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, {
			path: ["grouped.conf"],
			query: "needle",
		}));
		expect(result).toMatchObject({
			total_candidates: 3,
			returned_regions: 2,
			returned_files: 1,
			truncated_by: ["result_limit"],
		});
		expect(result.regions.map((region) => region.match_lines)).toEqual([[1], [2]]);
		const output = formatCompactGrepResult(result);
		expect(output).toContain("grouped.conf:\n  1: needle first\n  2: needle second");
		expect(output.match(/grouped\.conf/g)).toHaveLength(1);
	});

	it("超长 Unicode 行围绕真实匹配点安全截取", async () => {
		const line = `${"前".repeat(300)}😀needle目标${"后".repeat(300)}`;
		await writeFile(path.join(testContext.workspace, "unicode.conf"), `${line}\n`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "needle" }));
		const evidence = firstRegion(result).display_lines?.[0]?.text;
		expect(evidence).toBeDefined();
		expect([...(evidence ?? "")]).toHaveLength(240);
		expect(evidence).toContain("😀needle目标");
		expect(evidence?.startsWith("...")).toBe(true);
		expect(evidence?.endsWith("...")).toBe(true);
	});

	it.each([
		{
			name: "行首",
			line: `needle目标${"后".repeat(400)}`,
			start: 0,
			end: 6,
			assertion: (value: string) => value.startsWith("needle目标") && value.endsWith("..."),
		},
		{
			name: "行尾",
			line: `${"前".repeat(400)}目标needle`,
			start: 402,
			end: 408,
			assertion: (value: string) => value.startsWith("...") && value.endsWith("目标needle"),
		},
		{
			name: "超长匹配本身",
			line: `prefix${"😀".repeat(300)}suffix`,
			start: 6,
			end: 606,
			assertion: (value: string) => value.includes("😀".repeat(100)),
		},
	])("证据截取覆盖$name匹配", ({ line, start, end, assertion }) => {
		const compact = compactDisplayLine(line, start, end);
		expect([...compact]).toHaveLength(240);
		expect(assertion(compact)).toBe(true);
	});

	it("regex 正确处理空行、UTF-8 BOM、逐行状态重置和无字面锚点表达式", async () => {
		await writeFile(path.join(testContext.workspace, "empty.txt"), "value\n\n");
		const empty = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["empty.txt"], query: "^$" }));
		expect(empty.regions.map((region) => region.match_lines)).toEqual([[2]]);

		await writeFile(path.join(testContext.workspace, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Needle42\n")]));
		const bom = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["bom.txt"], query: "^Needle\\d+$" }));
		expect(firstRegion(bom)).toMatchObject({ match_lines: [1] });
		expect(firstRegion(bom).display_lines?.[0]?.text).toBe("Needle42");

		await writeFile(path.join(testContext.workspace, "state.txt"), "a1\na2\n---\n");
		const reset = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["state.txt"], query: "\\d" }));
		expect(reset.regions.map((region) => region.match_lines)).toEqual([[1], [2]]);
		const anchorless = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["state.txt"], query: "^[-]+$" }));
		expect(anchorless.regions.map((region) => region.match_lines)).toEqual([[3]]);
	});

	it("中文注释 regex 只返回携带可复核 match_lines 的真实文本行", async () => {
		const query = "代码索引使用的详细结果；保留 parser 失败状态与文件级 import 事实。";
		await writeFile(path.join(testContext.workspace, "design.ts"), `export const unrelated = true;\n// ${query}\nexport function lexicalOnly() { return unrelated; }\n`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query }));
		expect(result.regions).toHaveLength(1);
		expect(firstRegion(result)).toMatchObject({ path: "design.ts", kind: "text", match_lines: [2], query_match: "verified" });
		await assertStrictMatches(testContext.workspace, result, query);
	});

	it.each(["LargeNeedle", "LargeNeed\\w+"])("query=%s 可流式搜索超过旧 1 MiB 和 parse 上限的文件", async (query) => {
		await testContext.useConfig({ grep_ast_max_file_bytes: 1024 }, "large");
		await writeFile(path.join(testContext.workspace, "large.txt"), `${"padding\n".repeat(140_000)}LargeNeedle\n`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query }));
		expect(firstRegion(result)).toMatchObject({ path: "large.txt", query_match: "verified" });
		expect(result.stats.searched_bytes).toBeGreaterThan(1024 * 1024);
		expect(result.stats.parsed_files).toBe(0);
	});

	it("累计正文预算在下一文件前停止扫描并报告 byte_limit", async () => {
		await testContext.useConfig({ grep_max_search_bytes: 1024 }, "byte-limit");
		await writeFile(path.join(testContext.workspace, "a.txt"), `Needle42\n${"a".repeat(700)}`);
		await writeFile(path.join(testContext.workspace, "b.txt"), `Needle42\n${"b".repeat(700)}`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Needle42" }));
		expect(result.regions.map((region) => region.path)).toEqual(["a.txt"]);
		expect(result.stats).toMatchObject({ searched_files: 1, searched_bytes: 709, parsed_files: 0 });
		expect(result.truncated_by).toContain("byte_limit");
	});

	it("TextScanner 以正文 UTF-8 坐标存储 BOM 后的多字节命中并观测未保存命中数", async () => {
		const lines = "你😀hit\n".repeat(10_003);
		await writeFile(path.join(testContext.workspace, "hits.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines)]));
		await withFileToolsInvocation(testContext.workspace, "grep-hit-limit", async (opened) => {
			const inventory = expectInventorySuccess(await buildScopeInventory({ paths: ["hits.txt"] }, {
				filesystem: opened.filesystem,
				operation: opened.operation,
				maxDepth: 12,
				maxEntries: 100_000,
				maxSearchBytes: Number.MAX_SAFE_INTEGER,
			}));
			const scanned = expectSuccess(await scanInventoryText(inventory, queryPlan("hit"), {
				filesystem: opened.filesystem,
				operation: opened.operation,
			}));
			expect(scanned.hits).toHaveLength(10_000);
			expect(scanned.hits[0]).toMatchObject({
				line: 1,
				byteStart: 7,
				byteEnd: 10,
				matchStart: 3,
				matchEnd: 6,
			});
			expect(scanned.hits.at(-1)).toMatchObject({ line: 10_000 });
			expect(scanned.totalHits).toBe(10_003);
			expect(scanned.fileEvidence[0]?.anchors).toHaveLength(64);
			expect(scanned.stats).toMatchObject({
				droppedTextHits: 3,
				droppedRelatedAnchors: 10_003 - 64,
			});
		});
	});

	it("TextScanner 有界并发读取并按 inventory 顺序提交全局容量", async () => {
		const paths = Array.from({ length: 158 }, (_, index) => `${String(index).padStart(3, "0")}.txt`);
		await Promise.all(paths.map((file) => writeFile(path.join(testContext.workspace, file), "hit\n".repeat(64))));
		await withFileToolsInvocation(testContext.workspace, "grep-concurrent-scan", async (opened) => {
			const inventory = expectInventorySuccess(await buildScopeInventory({ paths: ["."] }, {
				filesystem: opened.filesystem,
				operation: opened.operation,
				maxDepth: 12,
				maxEntries: 100_000,
				maxSearchBytes: Number.MAX_SAFE_INTEGER,
			}));
			const release = deferredVoid();
			let active = 0;
			let maxActive = 0;
			const filesystem = overrideContent(opened.filesystem, (content) => ({
				async scanLines(file, options) {
					active += 1;
					maxActive = Math.max(maxActive, active);
					queueMicrotask(() => release.resolve());
					await release.promise;
					try {
						return await content.scanLines(file, options);
					} finally {
						active -= 1;
					}
				},
			}));
			const pending = scanInventoryText(inventory, queryPlan("hit"), {
				filesystem,
				operation: opened.operation,
			});
			const scanned = expectSuccess(await pending);
			expect(maxActive).toBeGreaterThanOrEqual(availableParallelism() >= 4 ? 2 : 1);
			expect(maxActive).toBeLessThanOrEqual(8);
			const retainedPaths = paths.flatMap((file) => Array<string>(64).fill(file)).slice(0, 10_000);
			expect(scanned.hits.map((hit) => hit.path)).toEqual(retainedPaths);
			expect(scanned.fileEvidence.flatMap((file) => file.anchors.map((anchor) => anchor.path))).toEqual(retainedPaths);
			expect(scanned.totalHits).toBe(10_112);
			expect(scanned.stats).toMatchObject({
				droppedTextHits: 112,
				droppedRelatedAnchors: 112,
			});
		});
	});

	it("inventory 后 identity 替换时 TextScanner 丢弃旧快照并区分递归跳过与显式错误", async () => {
		const filePath = path.join(testContext.workspace, "snapshot-race.txt");
		const replacementPath = path.join(testContext.outside, "snapshot-replacement.txt");
		await withFileToolsInvocation(testContext.workspace, "grep-snapshot-race", async (opened) => {
			for (const [paths, explicit] of [[["."], false], [["snapshot-race.txt"], true]] as const) {
				await writeFile(filePath, "needle\n");
				await writeFile(replacementPath, "current");
				const inventory = expectInventorySuccess(await buildScopeInventory({ paths }, {
					filesystem: opened.filesystem,
					operation: opened.operation,
					maxDepth: 12,
					maxEntries: 100_000,
					maxSearchBytes: Number.MAX_SAFE_INTEGER,
				}));
				await rm(filePath);
				await rename(replacementPath, filePath);
				const scanned = expectSuccess(await scanInventoryText(inventory, queryPlan("needle"), {
					filesystem: opened.filesystem,
					operation: opened.operation,
				}));
				expect(scanned.hits).toEqual([]);
				expect(scanned.stats.searchedFiles).toBe(0);
				if (explicit) expect(scanned.scopeErrors).toMatchObject([{ error: { code: "STALE_READ" } }]);
				else expect(scanned.stats.skipped).toMatchObject({ changed: 1 });
			}
		});
	});

	it("TextScanner 丢弃 changed-during-read 的部分命中并区分递归跳过与显式错误", async () => {
		await writeFile(path.join(testContext.workspace, "race.txt"), "needle\n");
		await withFileToolsInvocation(testContext.workspace, "grep-changed-scan", async (opened) => {
			let closes = 0;
			const filesystem = overrideContent(opened.filesystem, () => ({
				async scanLines() {
					return { ok: true, value: {
						async *[Symbol.asyncIterator]() {
							yield { ok: true as const, value: { line: 1, text: "needle", byteStart: 0, byteEnd: 6 } };
							yield { ok: false as const, error: { code: "changed-during-read" as const, message: "changed", path: "race.txt" } };
						},
						async close() { closes += 1; },
					} };
				},
			}));
			for (const [paths, explicit] of [[["."], false], [["race.txt"], true]] as const) {
				const inventory = expectInventorySuccess(await buildScopeInventory({ paths }, {
					filesystem,
					operation: opened.operation,
					maxDepth: 12,
					maxEntries: 100_000,
					maxSearchBytes: Number.MAX_SAFE_INTEGER,
				}));
				const scanned = await scanInventoryText(inventory, queryPlan("needle"), {
					filesystem,
					operation: opened.operation,
				});
				const success = expectSuccess(scanned);
				expect(success.hits).toEqual([]);
				if (explicit) expect(success.scopeErrors).toMatchObject([{ error: { code: "STALE_READ" } }]);
				else expect(success.stats.skipped).toMatchObject({ changed: 1 });
			}
			expect(closes).toBe(2);
		});
	});

	it("代码结果保留声明和真实命中行，不附带无关函数正文", async () => {
		await testContext.useConfig({ grep_ast_max_file_bytes: 65536 });
		await writeFile(path.join(testContext.workspace, "large.ts"), [
			"export function largeFunction() {",
			...Array.from({ length: 70 }, (_, index) => `  const padding${index} = '${"value ".repeat(8)}';`),
			"  return needle;", "}",
		].join("\n"));
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "needle" }));
		expect(firstRegion(result)).toMatchObject({ path: "large.ts", symbol: "largeFunction", match_lines: [72] });
		const output = formatCompactGrepResult(result);
		expect(output).toContain("return needle;");
		expect(output).not.toContain("padding0");
		for (const field of ["kind=", "roles=", "matched-by=", "declaration:"]) expect(output).not.toContain(field);
	});

	it("长声明有界展示，真实候选不因正文长度而丢失", async () => {
		await testContext.useConfig({ grep_ast_max_file_bytes: 65536 });
		const parameters = Array.from({ length: 400 }, (_, index) => `parameter${index}: string`).join(", ");
		await writeFile(path.join(testContext.workspace, "long.ts"), `function oversized(${parameters}) {\nreturn needle;\n}\n`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "needle" }));
		expect(result.regions).toHaveLength(1);
		expect(firstRegion(result).declaration).toHaveLength(240);
		expect(result.truncated_by).toEqual([]);
		expect(result.approx_tokens).toBe(countTextTokensSync(formatCompactGrepResult(result)).tokens);
	});

	it("结果限制保留相关性头部，相关性接近的后续候选分散到不同文件", async () => {
		await testContext.useConfig({ grep_result_limit: 6 });
		await writeFile(path.join(testContext.workspace, "a.ts"), Array.from({ length: 8 }, (_, index) => `function call${String(index).padStart(2, "0")}() { return needle; }`).join("\n"));
		for (let index = 8; index < 40; index++) await writeFile(path.join(testContext.workspace, `b${index}.ts`), `function call${index}() { return needle; }\n`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "needle" }));
		expect(result.regions).toHaveLength(6);
		expect(new Set(result.regions.map((region) => region.path)).size, JSON.stringify(result.ranking)).toBeGreaterThan(1);
		expect(result.truncated_by).toContain("result_limit");
		await testContext.useConfig({ grep_result_limit: 1 });
		const first = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "needle" }));
		expect(firstRegion(first)).toEqual(firstRegion(result));
	});
});

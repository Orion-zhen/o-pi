import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { ContentOperations } from "../../src/filesystem/contracts/content.js";
import type { WorkspaceFileSystem } from "../../src/filesystem/contracts/workspace.js";
import { buildScopeInventory } from "../../src/file-tools/grep/inventory.js";
import { packGrepResults, renderGrepSuccess } from "../../src/file-tools/grep/packer.js";
import { scanInventoryText } from "../../src/file-tools/grep/text-scanner.js";
import { countTextTokensSync } from "../../src/token-counter.js";
import { formatCompactGrepResult } from "../../src/file-tools/grep/command.js";
import { compactDisplayLine } from "../../src/file-tools/grep/display.js";
import { grepWorkspaceFiles } from "../helpers/grep-tool.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { isFailed } from "../../src/file-tools/shared/result.js";
import { createGrepTestContext, expectGrepSuccess, expectInventorySuccess, firstRegion, assertStrictMatches, writeConfig } from "./grep-fixtures.js";
import { packCandidate, packRegions, queryPlan } from "./grep-ranking-fixtures.js";

const testContext = createGrepTestContext();

describe("grep text search", () => {
	it.each(["/absolute.ts", "../escape.ts", "a/../escape.ts", "bad\0glob"])("拒绝越界或 NUL glob %j", async (glob) => {
		await expect(grepWorkspaceFiles(testContext.workspace, { query: "needle", glob })).resolves.toMatchObject({
			status: "failed",
			error: { code: "INVALID_PATH" },
		});
	});

	it.each([
		{ match: "literal" as const, query: "needle\nnext" },
		{ match: "literal" as const, query: "needle\rnext" },
		{ match: "regex" as const, query: "needle\nnext" },
		{ match: "regex" as const, query: "needle\rnext" },
	])("$match 拒绝 CR/LF 多行 query", async ({ match, query }) => {
		await expect(grepWorkspaceFiles(testContext.workspace, { query, match })).resolves.toMatchObject({
			status: "failed",
			error: { code: "INVALID_OPERATION" },
		});
	});

	it.each([
		["LF", "alpha\nNeedle42\nomega\n"],
		["CRLF", "alpha\r\nNeedle42\r\nomega\r\n"],
		["CR", "alpha\rNeedle42\romega\r"],
	] as const)("literal 对 %s 使用统一 logical line 语义", async (_newline, content) => {
		await writeFile(path.join(testContext.workspace, "lines.txt"), content);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Needle42", match: "literal" }));
		expect(firstRegion(result)).toMatchObject({ match_lines: [2], query_match: "verified" });
		expect(firstRegion(result).display_lines?.[0]?.text).toContain("Needle42");
	});

	it("AST 外文本使用单行协议，并对同一行的多个 occurrence 去重", async () => {
		await writeFile(path.join(testContext.workspace, "facts.conf"), "needle needle\n");
		const verified = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["facts.conf"], query: "needle", match: "literal" }));
		expect(verified.regions).toHaveLength(1);
		expect(firstRegion(verified)).toMatchObject({ kind: "text", match_lines: [1], display_lines: [{ line: 1, text: "needle needle", type: "match" }] });
		expect(formatCompactGrepResult(verified)).toContain("facts.conf:1: needle needle");
		expect(formatCompactGrepResult(verified)).not.toContain("kind=text");

		await writeFile(path.join(testContext.workspace, "semantic.conf"), "authentication request rejected\n");
		const semantic = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["semantic.conf"], query: "authentication rejected" }));
		expect(firstRegion(semantic)).toMatchObject({ kind: "text", query_match: "semantic", matched_by: ["lexical"] });
		expect(formatCompactGrepResult(semantic)).toContain("semantic.conf:1 [evidence=lexical]: authentication request rejected");
	});

	it("超长 Unicode 行围绕真实匹配点安全截取", async () => {
		const line = `${"前".repeat(300)}😀needle目标${"后".repeat(300)}`;
		await writeFile(path.join(testContext.workspace, "unicode.conf"), `${line}\n`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "needle", match: "literal" }));
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
		const empty = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["empty.txt"], query: "^$", match: "regex" }));
		expect(empty.regions.map((region) => region.match_lines)).toEqual([[2]]);

		await writeFile(path.join(testContext.workspace, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Needle42\n")]));
		const bom = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["bom.txt"], query: "^Needle\\d+$", match: "regex" }));
		expect(firstRegion(bom)).toMatchObject({ match_lines: [1] });
		expect(firstRegion(bom).display_lines?.[0]?.text).toBe("Needle42");

		await writeFile(path.join(testContext.workspace, "state.txt"), "a1\na2\n---\n");
		const reset = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["state.txt"], query: "\\d", match: "regex" }));
		expect(reset.regions.map((region) => region.match_lines)).toEqual([[1], [2]]);
		const anchorless = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { path: ["state.txt"], query: "^[-]+$", match: "regex" }));
		expect(anchorless.regions.map((region) => region.match_lines)).toEqual([[3]]);
	});

	it("中文注释 literal 只返回携带可复核 match_lines 的真实文本行", async () => {
		const query = "Repo Map 使用的详细结果；保留 parser 失败状态与文件级 import 事实。";
		await writeFile(path.join(testContext.workspace, "design.ts"), `export const unrelated = true;\n// ${query}\nexport function lexicalOnly() { return unrelated; }\n`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query, match: "literal" }));
		expect(result.regions).toHaveLength(1);
		expect(firstRegion(result)).toMatchObject({ path: "design.ts", kind: "text", match_lines: [2], query_match: "verified" });
		await assertStrictMatches(testContext.workspace, result, query, "literal");
	});

	it.each([
		["literal", "LargeNeedle"],
		["regex", "LargeNeed\\w+"],
	] as const)("%s 可流式搜索超过旧 1 MiB 和 parse 上限的文件", async (match, query) => {
		const configPath = path.join(testContext.outside, `large-${match}.jsonc`);
		await writeConfig(configPath, { grep_ast_max_file_bytes: 1024 });
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await writeFile(path.join(testContext.workspace, "large.txt"), `${"padding\n".repeat(140_000)}LargeNeedle\n`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query, match }));
		expect(firstRegion(result)).toMatchObject({ path: "large.txt", query_match: "verified" });
		expect(result.stats.searched_bytes).toBeGreaterThan(1024 * 1024);
		expect(result.stats.parsed_files).toBe(0);
	});

	it("正文扫描不按文件数量或累计字节提前停止", async () => {
		await writeFile(path.join(testContext.workspace, "a.txt"), `Needle42\n${"a".repeat(700)}`);
		await writeFile(path.join(testContext.workspace, "b.txt"), `Needle42\n${"b".repeat(700)}`);
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "Needle42", match: "literal" }));
		expect(result.regions.map((region) => region.path)).toEqual(["a.txt", "b.txt"]);
		expect(result.stats).toMatchObject({ searched_files: 2, searched_bytes: 1418, parsed_files: 0 });
		expect(result.truncated_by).not.toContain("traversal_limit");
	});

	it("TextScanner 以正文 UTF-8 坐标存储 BOM 后的多字节命中并显式报告候选截断", async () => {
		const lines = "你😀hit\n你😀hit\n你😀hit\n你😀hit\n你😀hit\n";
		await writeFile(path.join(testContext.workspace, "hits.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines)]));
		const host = new FileToolsHost();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-hit-limit" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		try {
			const inventory = expectInventorySuccess(await buildScopeInventory({ paths: ["hits.txt"] }, {
				filesystem: opened.filesystem,
				operation: opened.context,
				maxDepth: 12,
			}));
			const scanned = await scanInventoryText(inventory, queryPlan("hit", "literal"), {
				filesystem: opened.filesystem,
				operation: opened.context,
				maxStoredHits: 2,
			});
			if (isFailed(scanned)) throw new Error(scanned.error.message);
			expect(scanned.hits).toHaveLength(2);
			expect(scanned.hits[0]).toMatchObject({
				line: 1,
				byteStart: 7,
				byteEnd: 10,
				matchStart: 3,
				matchEnd: 6,
			});
			expect(scanned.totalHits).toBe(5);
			expect(scanned.truncationReasons).toEqual(["semantic_candidate_limit"]);
		} finally {
			opened.dispose();
			host.dispose();
		}
	});

	it("inventory 后 identity 替换时 TextScanner 丢弃旧快照并区分递归跳过与显式错误", async () => {
		const filePath = path.join(testContext.workspace, "snapshot-race.txt");
		const replacementPath = path.join(testContext.outside, "snapshot-replacement.txt");
		const host = new FileToolsHost();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-snapshot-race" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		try {
			for (const [paths, explicit] of [[["."], false], [["snapshot-race.txt"], true]] as const) {
				await writeFile(filePath, "needle\n");
				await writeFile(replacementPath, "current");
				const inventory = expectInventorySuccess(await buildScopeInventory({ paths }, {
					filesystem: opened.filesystem,
					operation: opened.context,
					maxDepth: 12,
				}));
				await rm(filePath);
				await rename(replacementPath, filePath);
				const scanned = await scanInventoryText(inventory, queryPlan("needle", "literal"), {
					filesystem: opened.filesystem,
					operation: opened.context,
				});
				if (isFailed(scanned)) throw new Error(scanned.error.message);
				expect(scanned.hits).toEqual([]);
				expect(scanned.stats.searchedFiles).toBe(0);
				if (explicit) expect(scanned.scopeErrors).toMatchObject([{ error: { code: "STALE_READ" } }]);
				else expect(scanned.stats.skipped).toMatchObject({ changed: 1 });
			}
		} finally {
			opened.dispose();
			host.dispose();
		}
	});

	it("TextScanner 丢弃 changed-during-read 的部分命中并区分递归跳过与显式错误", async () => {
		await writeFile(path.join(testContext.workspace, "race.txt"), "needle\n");
		const host = new FileToolsHost();
		const opened = await host.open({ cwd: testContext.workspace, sessionId: "grep-changed-scan" });
		if (isFailed(opened)) throw new Error(opened.error.message);
		let closes = 0;
		const content: ContentOperations = {
			readBytes: opened.filesystem.content.readBytes.bind(opened.filesystem.content),
			readText: opened.filesystem.content.readText.bind(opened.filesystem.content),
			decodeText: opened.filesystem.content.decodeText.bind(opened.filesystem.content),
			sliceText: opened.filesystem.content.sliceText.bind(opened.filesystem.content),
			async scanLines() {
				return { ok: true, value: {
					async *[Symbol.asyncIterator]() {
						yield { ok: true as const, value: { line: 1, text: "needle", byteStart: 0, byteEnd: 6 } };
						yield { ok: false as const, error: { code: "changed-during-read" as const, message: "changed", path: "race.txt" } };
					},
					async close() { closes += 1; },
				} };
			},
		};
		const filesystem: WorkspaceFileSystem = { ...opened.filesystem, content };
		try {
			for (const [paths, explicit] of [[["."], false], [["race.txt"], true]] as const) {
				const inventory = expectInventorySuccess(await buildScopeInventory({ paths }, {
					filesystem,
					operation: opened.context,
					maxDepth: 12,
				}));
				const scanned = await scanInventoryText(inventory, queryPlan("needle", "literal"), {
					filesystem,
					operation: opened.context,
				});
				if (isFailed(scanned)) throw new Error(scanned.error.message);
				expect(scanned.hits).toEqual([]);
				if (explicit) expect(scanned.scopeErrors).toMatchObject([{ error: { code: "STALE_READ" } }]);
				else expect(scanned.stats.skipped).toMatchObject({ changed: 1 });
			}
			expect(closes).toBe(2);
		} finally {
			opened.dispose();
			host.dispose();
		}
	});

	it("auto 保留现有多行 query 语义", async () => {
		await writeFile(path.join(testContext.workspace, "multiline.txt"), "needle\nnext\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(testContext.workspace, { query: "needle\nnext", match: "auto" }));
		expect(result.regions).toEqual([]);
	});

	it("紧凑输出使用显式 region metadata 和 body-free declaration", () => {
		const output = renderGrepSuccess({
			status: "success",
			query: "handler",
			path: ".",
			match: "auto",
			total_candidates: 2,
			returned_regions: 2,
			returned_files: 2,
			approx_tokens: 0,
			stats: { traversed_entries: 2, searched_files: 2, searched_bytes: 100, parsed_files: 2 },
			truncated_by: [],
			regions: [
				{
					path: "src/features/authentication/first-handler.ts",
					start_line: 1,
					end_line: 3,
					kind: "function",
					symbol: "firstHandler",
					declaration: "function firstHandler(input: AuthInput): Session",
					query_match: "semantic",
					matched_by: ["exact-symbol"],
					sources: ["ast-symbol"],
				},
				{
					path: "src/features/authentication/second-handler.ts",
					start_line: 5,
					end_line: 7,
					kind: "function",
					symbol: "secondHandler",
					query_match: "semantic",
					matched_by: ["relationship"],
					sources: ["ast-relation"],
				},
			],
		});

		expect(output).toContain("src/features/authentication/first-handler.ts:1-3 [kind=function; symbol=firstHandler; matched-by=exact-symbol]");
		expect(output).toContain("declaration: function firstHandler(input: AuthInput): Session");
	});

	it("strict 匹配行本身超预算时跳过候选而不伪装成无证据命中", () => {
		const longLine = `  const value = '${"needle".repeat(80)}';\n`;
		const source = `export function oversizedNeedle(): string {\n${longLine.repeat(80)}  return value;\n}\n`;
		const candidate = packCandidate({
			id: "oversized",
			path: "src/oversized.ts",
			startLine: 1,
			endLine: 83,
			endByte: Buffer.byteLength(source),
			matchLine: 40,
			symbol: "oversizedNeedle",
			declaration: "function oversizedNeedle(): string",
			lineText: longLine.trimEnd(),
		});
		const result = packGrepResults({
			query: "needle",
			path: ".",
			match: "literal",
			totalCandidates: 1,
			regions: [candidate],
			stats: { traversed_entries: 1, searched_files: 1, searched_bytes: Buffer.byteLength(source), parsed_files: 1 },
			truncationReasons: [],
			tokenBudget: 100,
			resultLimit: 1,
			regionalDisplayLimit: 3,
			nearby: [],
			related: [],
		});

		expect(result.regions).toEqual([]);
		expect(result.truncated_by).toContain("token_budget");
		expect(countTextTokensSync(formatCompactGrepResult(result)).tokens).toBeLessThanOrEqual(100);
	});

	it("固定区域胶囊不随 source body 或剩余预算升级", () => {
		const source = [
			"export function largeNeedle() {",
			...Array.from({ length: 70 }, (_, index) => `  const padding${index} = '${"value ".repeat(8)}';`),
			"  return needle;",
			"}",
		].join("\n");
		const large = packCandidate({
			id: "large",
			path: "a-large.ts",
			startLine: 1,
			endLine: 73,
			endByte: Buffer.byteLength(source),
			matchLine: 72,
			symbol: "largeNeedle",
			declaration: "function largeNeedle()",
			lineText: "  return needle;",
		});
		const second = packCandidate({ id: "second", path: "b.ts", startLine: 1, endLine: 1, endByte: 1, matchLine: 1 });
		const third = packCandidate({ id: "third", path: "c.ts", startLine: 1, endLine: 1, endByte: 1, matchLine: 1 });
		const result = packRegions([large, second, third], {
			resultLimit: 3,
			tokenBudget: 180,
		});
		const expandedBudget = packRegions([large, second, third], { resultLimit: 3, tokenBudget: 400 });

		expect(result.regions.map((region) => region.path)).toEqual(["a-large.ts", "b.ts", "c.ts"]);
		expect(firstRegion(expandedBudget)).toEqual(firstRegion(result));
		expect(firstRegion(result)).toMatchObject({ match_lines: [72], display_lines: [expect.objectContaining({ text: "  return needle;" })] });
		expect(formatCompactGrepResult(result)).not.toContain("lines omitted");
		expect(formatCompactGrepResult(result)).not.toContain("padding0");
		expect(result.approx_tokens).toBeLessThanOrEqual(180);
	});

	it("超长 declaration 被固定截取并稳定合并截断原因", () => {
		const hugeDeclaration = `function oversized(${Array.from({ length: 400 }, (_, index) => `parameter${index}: string`).join(", ")})`;
		const oversized = packCandidate({
			id: "oversized-declaration",
			path: "a-oversized.ts",
			startLine: 1,
			endLine: 1,
			endByte: 1,
			matchLine: 1,
			declaration: hugeDeclaration,
		});
		const second = packCandidate({ id: "second", path: "b-second.ts", startLine: 1, endLine: 1, endByte: 1, matchLine: 1 });
		const third = packCandidate({ id: "third", path: "c-third.ts", startLine: 1, endLine: 1, endByte: 1, matchLine: 1 });
		const result = packRegions([oversized, second, third], {
			resultLimit: 2,
			tokenBudget: 180,
			truncationReasons: ["semantic_candidate_limit", "traversal_limit"],
		});

		expect(result.regions.map((region) => region.path)).toContain("a-oversized.ts");
		expect(firstRegion(result).declaration).toHaveLength(240);
		expect(result.truncated_by).toEqual([
			"traversal_limit",
			"semantic_candidate_limit",
			"result_limit",
		]);
		expect(result.approx_tokens).toBe(countTextTokensSync(formatCompactGrepResult(result)).tokens);
		expect(result.approx_tokens).toBeLessThanOrEqual(180);
	});

	it("nearby 只在 main 为空时占用预算，辅助候选超限后继续尝试", () => {
		const hugePath = `a/${Array.from({ length: 400 }, (_, index) => `segment-${index}`).join("/")}.ts`;
		const nearby = [
			{ path: hugePath, start_line: 1, end_line: 1, kind: "function", reason: "symbol similarity" as const, query_match: "not_guaranteed" as const },
			{ path: "b.ts", start_line: 1, end_line: 1, kind: "function", symbol: "near", reason: "symbol similarity" as const, query_match: "not_guaranteed" as const },
		];
		const related = [
			{ path: hugePath, kind: "function", sources: ["repo-map-direct"], relations: ["test"], query_match: "not_guaranteed" as const },
			{ path: "d.ts", kind: "function", symbol: "related", sources: ["repo-map-direct"], relations: ["test"], query_match: "not_guaranteed" as const },
		];
		const empty = packRegions([], { nearby, related, tokenBudget: 140 });
		expect(empty.nearby?.map((item) => item.path)).toEqual(["b.ts"]);
		expect(empty.related?.map((item) => item.path)).toEqual(["d.ts"]);
		expect(empty.truncated_by).toEqual(["token_budget"]);
		expect(empty.approx_tokens).toBeLessThanOrEqual(140);

		const main = packCandidate({ id: "main", path: "main.ts", startLine: 1, endLine: 1, endByte: 1, matchLine: 1 });
		const cheapRelated = related[1];
		if (cheapRelated === undefined) throw new Error("missing related fixture");
		const withMain = packRegions([main], { nearby, related: [cheapRelated], tokenBudget: 140, resultLimit: 1 });
		expect(withMain.nearby).toBeUndefined();
		expect(withMain.related).toBeUndefined();
		expect(withMain.truncated_by).toContain("result_limit");
	});

	it.each([
		[0, 2],
		[1, 2],
		[2, 4],
	] as const)("%i 个 main 最多返回 %i 个 related", (mainCount, expectedRelated) => {
		const main = Array.from({ length: mainCount }, (_, index) => packCandidate({
			id: `main-${index}`,
			path: `main-${index}.ts`,
			startLine: 1,
			endLine: 1,
			endByte: 1,
			matchLine: 1,
		}));
		const related = Array.from({ length: 6 }, (_, index) => ({
			path: `related-${index}.ts`,
			kind: "function",
			sources: ["repo-map-direct"],
			relations: ["test"],
			query_match: "not_guaranteed" as const,
		}));
		const result = packRegions(main, { related, resultLimit: 10, tokenBudget: 2_000 });
		expect(result.regions).toHaveLength(mainCount);
		expect(result.related ?? []).toHaveLength(expectedRelated);
		expect(result.truncated_by).toContain("result_limit");
	});
});
